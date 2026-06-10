'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT_DIR = __dirname;
const LOG_DIR = path.join(ROOT_DIR, 'logs');
const RETRY_MS = Number.parseInt(process.env.SCRAPER_RETRY_MS || '300000', 10);
const args = process.argv.slice(2);

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
const logPath = path.join(LOG_DIR, `continuous_${stamp}.log`);

function log(message) {
  const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${message}`;
  fs.appendFileSync(logPath, `${line}\n`, 'utf8');
  console.log(line);
}

function isRetryable(output) {
  return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|socket hang up|Timeout/i.test(output);
}

function isAntiBot(output) {
  return /anti-bot|not a bot|anubis|certificando de que voce nao e um bot|checking your browser/i.test(
    output.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  );
}

function runOnce() {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['scraper.js', ...args], {
      cwd: ROOT_DIR,
      windowsHide: true,
    });

    let output = '';
    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      output += text;
      fs.appendFileSync(logPath, text, 'utf8');
      process.stdout.write(text);
    });
    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      output += text;
      fs.appendFileSync(logPath, text, 'utf8');
      process.stderr.write(text);
    });
    child.on('close', code => resolve({ code, output }));
  });
}

async function main() {
  log(`Supervisor iniciado. Log: ${logPath}`);
  log(`Args scraper: ${args.join(' ') || '(nenhum)'}`);

  while (true) {
    const result = await runOnce();
    if (result.code === 0) {
      log('Scraper concluiu com sucesso. Supervisor encerrado.');
      return;
    }

    if (isAntiBot(result.output)) {
      log('Bloqueio anti-bot detectado. Supervisor encerrado sem insistir.');
      process.exitCode = result.code || 1;
      return;
    }

    if (!isRetryable(result.output)) {
      log(`Erro nao classificado para retry automatico. Codigo: ${result.code}. Supervisor encerrado.`);
      process.exitCode = result.code || 1;
      return;
    }

    log(`Erro de rede detectado. Nova tentativa em ${Math.round(RETRY_MS / 1000)}s.`);
    await new Promise(resolve => setTimeout(resolve, RETRY_MS));
  }
}

main().catch(error => {
  log(`Erro fatal no supervisor: ${error.message}`);
  process.exit(1);
});
