'use strict';

/**
 * fix-incomplete-cards.js
 *
 * Varre todos os cartões em dados/ e identifica os que possuem campos com
 * "Confirm you are human to view details" — indicando que o Colnect exigiu
 * autenticação para exibir os detalhes na hora da extração.
 *
 * Uso:
 *   node fix-incomplete-cards.js          # lista os cartões incompletos
 *   node fix-incomplete-cards.js --json   # salva resultado em _cartoes_incompletos.json
 */

const fs   = require('fs');
const path = require('path');

const ROOT           = __dirname;
const DATA_DIR       = path.join(ROOT, 'dados');
const OUTPUT_FILE    = path.join(ROOT, '_cartoes_incompletos.json');

const BLOCKED_TEXT   = 'confirm you are human to view details';
const SAVE_JSON      = process.argv.includes('--json');

function isBlocked(value) {
  return typeof value === 'string' && value.toLowerCase().includes(BLOCKED_TEXT);
}

function findBlockedFields(card) {
  const blocked = [];
  for (const [key, value] of Object.entries(card)) {
    if (key === 'propriedades' && value && typeof value === 'object') {
      for (const [propKey, propValue] of Object.entries(value)) {
        if (isBlocked(propValue)) blocked.push(`propriedades.${propKey}`);
      }
    } else if (isBlocked(value)) {
      blocked.push(key);
    }
  }
  return blocked;
}

const incomplete = [];
let totalScanned = 0;
let totalIncomplete = 0;

for (const opDir of fs.readdirSync(DATA_DIR)) {
  const fullOpDir = path.join(DATA_DIR, opDir);
  try { if (!fs.statSync(fullOpDir).isDirectory()) continue; } catch { continue; }

  for (const file of fs.readdirSync(fullOpDir)) {
    if (!file.endsWith('.js') || file === '_index.js') continue;
    const fullPath = path.join(fullOpDir, file);
    totalScanned++;

    let card;
    try {
      delete require.cache[require.resolve(fullPath)];
      card = require(fullPath);
    } catch { continue; }

    if (!card || !card.id_colnect) continue;

    const blockedFields = findBlockedFields(card);
    if (blockedFields.length === 0) continue;

    totalIncomplete++;
    const entry = {
      id_colnect:    card.id_colnect,
      nome:          card.nome          || '',
      url_colnect:   card.url_colnect   || '',
      operadora:     card.operadora_nome || opDir,
      operadora_dir: opDir,
      campos_bloqueados: blockedFields,
      registrado_em: new Date().toISOString(),
    };
    incomplete.push(entry);

    if (!SAVE_JSON) {
      console.log(`[${card.id_colnect}] ${card.nome}`);
      console.log(`  Operadora : ${entry.operadora}`);
      console.log(`  URL       : ${card.url_colnect}`);
      console.log(`  Campos    : ${blockedFields.join(', ')}`);
      console.log('');
    }
  }
}

console.log(`=== Resumo ===`);
console.log(`Cartões verificados : ${totalScanned}`);
console.log(`Cartões incompletos : ${totalIncomplete}`);

if (SAVE_JSON) {
  const output = {
    gerado_em:   new Date().toISOString(),
    total:       incomplete.length,
    cartoes:     incomplete,
  };
  const tmp = OUTPUT_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(output, null, 2), 'utf8');
  fs.renameSync(tmp, OUTPUT_FILE);
  console.log(`\nSalvo em: _cartoes_incompletos.json`);
}
