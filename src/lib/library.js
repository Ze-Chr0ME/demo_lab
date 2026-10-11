// Keeps track of finished clips/montages in <outputDir>/clipmaker-library.json.
const fs = require('fs');
const path = require('path');

class Library {
  constructor(dir) { this.dir = dir; }
  get file() { return path.join(this.dir, 'clipmaker-library.json'); }

  list() {
    let items = [];
    try { items = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    // Drop entries whose video was deleted outside the app.
    return items.filter(c => fs.existsSync(c.file));
  }

  save(items) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(items, null, 2));
  }

  add(item) {
    const items = this.list().filter(c => c.file !== item.file);
    items.unshift(item);
    this.save(items);
    return item;
  }

  remove(id) {
    const items = this.list();
    const item = items.find(c => c.id === id);
    this.save(items.filter(c => c.id !== id));
    return item;
  }
}

module.exports = { Library };
