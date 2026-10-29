const { REMOTE_IMAGE } = require('./utility');

const matchesImage = (bytes, ext) => {
  if (ext === '.jpg' || ext === '.jpeg') return bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (ext === '.png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return ext === '.webp' && bytes.length >= 12 && bytes.subarray(0, 4).equals(Buffer.from('RIFF')) && bytes.subarray(8, 12).equals(Buffer.from('WEBP'));
};

const imageBackup = (list, upload) => {
  const pending = new Map();
  return file => {
    const remote = list().map(x => x.remote?.[file]).find(id => REMOTE_IMAGE.test(id || ''));
    if (remote) return Promise.resolve(remote);
    if (!pending.has(file)) {
      const job = Promise.resolve().then(() => upload(file)).finally(() => pending.delete(file));
      pending.set(file, job);
    }
    return pending.get(file);
  };
};

module.exports = { matchesImage, imageBackup };
