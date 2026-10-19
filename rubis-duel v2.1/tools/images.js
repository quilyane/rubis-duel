// Liste les images attendues pour chaque deck et celles qui manquent encore.
// Dépose les fichiers dans public/img/<id-du-deck>/<id-du-personnage>.webp (ou .png, .jpg, .avif)
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let missingTotal = 0;
for (const f of fs.readdirSync(path.join(root, 'decks')).filter((x) => x.endsWith('.json')).sort()) {
  const d = JSON.parse(fs.readFileSync(path.join(root, 'decks', f), 'utf8'));
  const dir = path.join(root, 'public', 'img', d.id);
  fs.mkdirSync(dir, { recursive: true });
  const have = new Set(fs.readdirSync(dir).map((x) => x.replace(/\.[^.]+$/, '').toLowerCase()));
  const missing = d.characters.filter((c) => !have.has(c.id.toLowerCase()));
  missingTotal += missing.length;
  console.log(`\n${d.name} (${d.characters.length - missing.length}/${d.characters.length} images) → public/img/${d.id}/`);
  for (const c of missing) console.log(`  ${c.id}.webp   (${c.name})`);
}
console.log(missingTotal ? `\n${missingTotal} image(s) manquante(s). Sans image, la carte affiche les initiales du personnage.` : '\nToutes les images sont présentes.');
