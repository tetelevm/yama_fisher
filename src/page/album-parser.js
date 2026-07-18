/**
 * Isolates extraction of album state patches from Yandex Music HTML.
 * The parser intentionally preserves the existing page-expression approach.
 */
(() => {
    const app = globalThis.yaMaFisher ||= {};
    const PATCHES_PATTERN = new RegExp(
        String.raw`\(window\.__STATE_PATCHES__\s*=\s*window\.__STATE_PATCHES__`
            + String.raw`\s*\|\|\s*\[\]\)\.push\(([\s\S]*?)\);`,
        'g'
    );

    function buildStateTree(patches) {
        return patches.flat().reduce((tree, patch) => {
            if (!patch?.path) return tree;
            const keys = patch.path.split('/').filter(Boolean);
            const lastKey = keys.pop();
            const target = keys.reduce((branch, key) => branch[key] ||= {}, tree);
            if (lastKey !== undefined) target[lastKey] = patch.value;
            return tree;
        }, {});
    }

    function parse(documentHtml) {
        const documentData = new DOMParser().parseFromString(documentHtml, 'text/html');
        const patches = [];
        documentData.querySelectorAll('body > script').forEach(script => {
            for (const match of script.textContent.matchAll(PATCHES_PATTERN)) {
                try {
                    patches.push(new Function(`return ${match[1]};`)());
                } catch {
                    // Page scripts may contain fragments that are not state patch data.
                }
            }
        });
        return buildStateTree(patches).album || null;
    }

    app.collectionParsers ||= {};
    app.collectionParsers.album = Object.freeze({parse});
})();
