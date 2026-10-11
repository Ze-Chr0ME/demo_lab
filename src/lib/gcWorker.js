// Asks the CS2 Game Coordinator for your recent matches through the running Steam client
// (same request CS2's Watch tab makes). Run as a separate process — while it runs Steam shows
// you as "playing CS2" — with env SteamAppId=730. Prints one JSON line on stdout.
//
// usage: node gcWorker.js <path to CS2's steam_api64.dll> [CS2 client version from steam.inf]
const koffi = require('koffi');
const { decode, encodeVarints } = require('./proto');

const PROTO_FLAG = 0x80000000;
const MSG = { ClientHello: 4006, ClientWelcome: 4004, RecentUserGames: 9141, MatchList: 9139 };
const STEAMID64_BASE = 76561197960265728n;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

async function main() {
  const lib = koffi.load(process.argv[2]);
  const initFlat = lib.func('int SteamAPI_InitFlat(_Out_ uint8_t *err)');
  const shutdown = lib.func('void SteamAPI_Shutdown()');
  const runCallbacks = lib.func('void SteamAPI_RunCallbacks()');
  const getUser = lib.func('int SteamAPI_GetHSteamUser()');
  const findIface = lib.func('void *SteamInternal_FindOrCreateUserInterface(int user, str version)');
  const steamUser = lib.func('void *SteamAPI_SteamUser_v023()');
  const getSteamId = lib.func('uint64 SteamAPI_ISteamUser_GetSteamID(void *self)');

  const err = Buffer.alloc(1024);
  const rc = initFlat(err);
  if (rc !== 0) {
    const msg = err.toString('utf8').replace(/\0.*$/s, '');
    throw new Error(rc === 2 ? 'Steam is not running. Start Steam and try again.' : `Steam refused the connection (${rc}): ${msg}`);
  }

  try {
    const steamid = BigInt(getSteamId(steamUser()));
    const accountId = Number(steamid - STEAMID64_BASE);
    const gc = findIface(getUser(), 'SteamGameCoordinator001');
    if (!gc) throw new Error('Steam did not provide the Game Coordinator interface.');

    // ISteamGameCoordinator vtable: SendMessage, IsMessageAvailable, RetrieveMessage
    const vtable = koffi.decode(gc, 'void *');
    const [pSend, pAvail, pRetrieve] = koffi.decode(vtable, koffi.array('void *', 3));
    const SendFn = koffi.proto('int SendFn(void *self, uint32 type, const uint8_t *data, uint32 size)');
    const AvailFn = koffi.proto('bool AvailFn(void *self, _Out_ uint32 *size)');
    const RetrieveFn = koffi.proto('int RetrieveFn(void *self, _Out_ uint32 *type, _Out_ uint8_t *dest, uint32 cub, _Out_ uint32 *size)');
    const send = koffi.decode(pSend, SendFn);
    const avail = koffi.decode(pAvail, AvailFn);
    const retrieve = koffi.decode(pRetrieve, RetrieveFn);

    const sendMsg = (type, body) => {
      const head = Buffer.alloc(8);
      head.writeUInt32LE((type | PROTO_FLAG) >>> 0, 0);
      head.writeUInt32LE(0, 4); // no proto header
      const buf = Buffer.concat([head, body]);
      return send(gc, (type | PROTO_FLAG) >>> 0, buf, buf.length);
    };

    const version = Number(process.argv[3]) || 0;
    const pending = [];
    const pump = () => {
      runCallbacks();
      const size = [0];
      while (avail(gc, size)) {
        const dest = Buffer.alloc(size[0]);
        const type = [0], got = [0];
        if (retrieve(gc, type, dest, dest.length, got) !== 0) break;
        const msgType = (type[0] & ~PROTO_FLAG) >>> 0;
        const hdrLen = dest.readUInt32LE(4);
        if (process.env.CLIPMAKER_GC_DEBUG) process.stderr.write(`[gc] got ${msgType} (${got[0]} bytes)
`);
        pending.push({ type: msgType, body: dest.subarray(8 + hdrLen, got[0]) });
      }
    };
    const waitFor = async (type, ms, onTick) => {
      const until = Date.now() + ms;
      let lastTick = 0;
      while (Date.now() < until) {
        pump();
        const i = pending.findIndex(m => m.type === type);
        if (i >= 0) return pending.splice(i, 1)[0];
        if (onTick && Date.now() - lastTick > 2000) { lastTick = Date.now(); onTick(); }
        await sleep(100);
      }
      return null;
    };

    // Say hello until the GC welcomes us, then ask for the match list.
    const welcome = await waitFor(MSG.ClientWelcome, 30000, () => sendMsg(MSG.ClientHello, encodeVarints(version ? [[1, version]] : [])));
    if (!welcome) throw new Error('No answer from the CS2 Game Coordinator (Valve servers busy or offline?). Try again later.');

    const list = await waitFor(MSG.MatchList, 20000, () => sendMsg(MSG.RecentUserGames, encodeVarints([[1, accountId]])));
    if (!list) throw new Error('The Game Coordinator did not send your match list. Try again later.');

    // The GC may answer with several lists; collect anything that arrives shortly after.
    const lists = [list];
    for (let extra; (extra = await waitFor(MSG.MatchList, 3000));) lists.push(extra);
    const matches = lists.flatMap(l => decode(l.body)[4] || []).map(b => Buffer.from(b).toString('base64'));
    out({ ok: true, steamid: steamid.toString(), lists: lists.length, matches });
  } finally {
    shutdown();
  }
}

main().catch(e => out({ ok: false, error: e.message || String(e) })).finally(() => setTimeout(() => process.exit(0), 50));
