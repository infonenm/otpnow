/**
 * Preload for test/shutdown.test.js: a Firestore stand-in that persists every
 * document to a JSON file, so a test can kill the server and read what was
 * actually saved. Loaded with `node -r`, before server.js initialises Firestore.
 */
const fs = require('fs');
const firestore = require('../../lib/firestore');
const FILE = process.env.FAKE_FIRESTORE_FILE;

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return {}; } }
function save(all) { fs.writeFileSync(FILE, JSON.stringify(all)); }

firestore.init = function () {
    const query = () => {
        const q = { where: () => q, orderBy: () => q, limit: () => q,
                    get: async () => ({ empty: true, size: 0, forEach: () => {} }) };
        return q;
    };
    firestore._setDbForTests({
        batch: () => {
            const pending = [];
            return {
                set: (ref, v) => pending.push([ref.path, v]),
                delete: () => {},
                commit: async () => {
                    const all = load();
                    for (const [p, v] of pending) all[p] = v;
                    save(all);
                }
            };
        },
        collection: (c) => Object.assign(query(), {
            doc: (id) => ({
                path: c + '/' + id,
                get: async () => { const d = load()[c + '/' + id];
                                   return { exists: !!d, data: () => d }; },
                // Slow on purpose: a real cold write takes time, and the process
                // must wait for it rather than exit underneath it.
                set: (v) => new Promise(r => setTimeout(() => {
                    const all = load(); all[c + '/' + id] = v; save(all); r();
                }, 300))
            })
        })
    });
};
