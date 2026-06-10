'use strict';

/**
 * fix-blocked-images.js
 *
 * Varre todas as imagens já baixadas, detecta as que são o placeholder
 * "imagem bloqueada" (retângulo preto, requer login no Colnect), remove-as
 * do disco e registra os cartões afetados em _imagens_bloqueadas.json para
 * re-download futuro com sessão autenticada.
 *
 * Uso:
 *   node fix-blocked-images.js          # modo dry-run (só lista, não apaga)
 *   node fix-blocked-images.js --fix    # apaga as imagens e atualiza os .js
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Hashes conhecidos de imagens placeholder ─────────────────────────────────
// Adicione aqui novos hashes caso o site passe a servir outros placeholders.
const PLACEHOLDER_HASHES = new Set([
  'd812f4defbdb2f9ff7084505226c0878607145436f59a3df1524d9ab88ebb867', // retângulo preto vertical (4928b)
]);

const ROOT         = __dirname;
const DATA_DIR     = path.join(ROOT, 'dados');
const IMAGES_DIR   = path.join(ROOT, 'imagens');
const BLOCKED_FILE = path.join(ROOT, '_imagens_bloqueadas.json');

const DRY_RUN = !process.argv.includes('--fix');

if (DRY_RUN) {
  console.log('=== MODO DRY-RUN (use --fix para aplicar as correções) ===\n');
} else {
  console.log('=== MODO FIX (apagando imagens placeholder e atualizando .js) ===\n');
}

// ─── Utilitários ─────────────────────────────────────────────────────────────

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

// ─── Lê todos os cartões (.js) de uma operadora ──────────────────────────────
function readCardFiles(dataDir) {
  const cards = [];
  if (!fs.existsSync(dataDir)) return cards;
  for (const file of fs.readdirSync(dataDir)) {
    if (!file.endsWith('.js') || file === '_index.js') continue;
    const fullPath = path.join(dataDir, file);
    try {
      delete require.cache[require.resolve(fullPath)];
      const data = require(fullPath);
      if (data && data.id_colnect) cards.push({ data, path: fullPath });
    } catch {
      // ignora arquivos corrompidos
    }
  }
  return cards;
}

// ─── Principal ───────────────────────────────────────────────────────────────

const placeholderHashes = PLACEHOLDER_HASHES;
console.log(`Hashes de placeholder conhecidos: ${placeholderHashes.size}`);

const blockedRegistry = readJson(BLOCKED_FILE, { atualizado_em: null, total: 0, cartoes: [] });
const alreadyRegistered = new Set(blockedRegistry.cartoes.map(c => String(c.id_colnect)));

let totalScanned   = 0;
let totalPlaceholder = 0;
let totalDeleted   = 0;
let totalUpdatedJs = 0;

// Mapeia id_colnect -> info do cartão para atualizar os .js
const cardIndex = new Map(); // id_colnect -> { data, path, operadoraDir }

// Primeiro passo: indexa todos os cartões por id
if (fs.existsSync(DATA_DIR)) {
  for (const opDir of fs.readdirSync(DATA_DIR)) {
    const fullOpDir = path.join(DATA_DIR, opDir);
    try { if (!fs.statSync(fullOpDir).isDirectory()) continue; } catch { continue; }
    for (const entry of readCardFiles(fullOpDir)) {
      cardIndex.set(String(entry.data.id_colnect), { ...entry, operadoraDir: opDir });
    }
  }
}
console.log(`Cartões indexados: ${cardIndex.size}\n`);

// Segundo passo: varre imagens
if (fs.existsSync(IMAGES_DIR)) {
  for (const opDir of fs.readdirSync(IMAGES_DIR)) {
    const fullOpDir = path.join(IMAGES_DIR, opDir);
    try { if (!fs.statSync(fullOpDir).isDirectory()) continue; } catch { continue; }

    for (const imgFile of fs.readdirSync(fullOpDir)) {
      if (!/\.(jpg|jpeg|png|webp)$/i.test(imgFile)) continue;
      const imgPath = path.join(fullOpDir, imgFile);

      let buf;
      try { buf = fs.readFileSync(imgPath); } catch { continue; }
      totalScanned++;

      const hash = sha256(buf);
      if (!placeholderHashes.has(hash)) continue;

      totalPlaceholder++;

      // Extrai id_colnect do nome do arquivo (padrão: <id>_<nome>.jpg)
      const idMatch = imgFile.match(/^(\d+)_/);
      const cardId  = idMatch ? idMatch[1] : null;

      console.log(`PLACEHOLDER: ${opDir}/${imgFile} (${buf.length}b)`);

      if (!DRY_RUN) {
        try { fs.unlinkSync(imgPath); totalDeleted++; } catch (e) {
          console.error(`  ERRO ao apagar: ${e.message}`);
        }
      }

      // Registra na lista de bloqueados e atualiza o .js do cartão
      if (cardId && !alreadyRegistered.has(cardId)) {
        const cardEntry = cardIndex.get(cardId);
        blockedRegistry.cartoes.push({
          id_colnect:    cardId,
          nome:          cardEntry?.data?.nome          || '',
          url_colnect:   cardEntry?.data?.url_colnect   || '',
          operadora:     cardEntry?.data?.operadora_nome || opDir,
          operadora_dir: opDir,
          registrado_em: new Date().toISOString(),
        });
        alreadyRegistered.add(cardId);
      }

      // Atualiza o .js do cartão: marca imagem_bloqueada e limpa listas locais
      if (cardId && !DRY_RUN) {
        const cardEntry = cardIndex.get(cardId);
        if (cardEntry) {
          const updated = {
            ...cardEntry.data,
            imagem_bloqueada: true,
            imagem_principal: '',
            imagem_high_principal: '',
            // Remove da lista de arquivos locais as entradas placeholder
            imagens_local: [],
            imagens_high_local: [],
            imagens_variantes_local: (cardEntry.data.imagens_variantes_local || []).filter(
              v => fs.existsSync(path.join(IMAGES_DIR, opDir, v.arquivo))
            ),
          };
          fs.writeFileSync(cardEntry.path, 'module.exports = ' + JSON.stringify(updated, null, 2) + ';\n', 'utf8');
          totalUpdatedJs++;
        }
      }
    }
  }
}

// Salva o registro de bloqueados
if (!DRY_RUN) {
  blockedRegistry.atualizado_em = new Date().toISOString();
  blockedRegistry.total = blockedRegistry.cartoes.length;
  writeJson(BLOCKED_FILE, blockedRegistry);
}

console.log('\n=== Resumo ===');
console.log(`Imagens verificadas:  ${totalScanned}`);
console.log(`Placeholders encontrados: ${totalPlaceholder}`);
if (!DRY_RUN) {
  console.log(`Imagens apagadas:     ${totalDeleted}`);
  console.log(`Cartões .js atualizados: ${totalUpdatedJs}`);
  console.log(`Cartões em _imagens_bloqueadas.json: ${blockedRegistry.total}`);
} else {
  console.log(`\nRode com --fix para apagar as ${totalPlaceholder} imagens placeholder.`);
}
