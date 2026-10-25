// Entry for `node --test tests/`: Node 22 resolves the directory argument to this file, which loads every test file.
const fs = require("node:fs");
const path = require("node:path");
for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith(".test.mjs")).sort()) import(path.join(__dirname, f));
