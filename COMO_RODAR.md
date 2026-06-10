# Como rodar a coleta

Este scraper nao tenta contornar bloqueios anti-bot. Ele reduz repeticao de requests, usa pausas, salva progresso e para de forma limpa se o site bloquear.

## 1. Rodar um teste pequeno

```powershell
node scraper.js --operadora Embratel --limite 10
node build-catalog.js
```

Abra `catalogo.html` no navegador.

## 2. Rodar a coleta completa

```powershell
node scraper.js
node build-catalog.js
```

O processo pode demorar muitos dias. Se for interrompido, rode `node scraper.js` novamente. Ele reaproveita:

- `dados/<operadora>/_links.json`: links ja descobertos por operadora.
- `dados/<operadora>/*.js`: cartoes ja salvos.
- `imagens/<operadora>/*`: imagens normais e imagens `_high` ja baixadas.
- `_estado_scraper.json`: estado geral da ultima execucao.

As imagens sao salvas por lado do cartao e por variante:

- `_thumb`: CDN `/t/`, miniatura.
- sem sufixo: CDN `/f/`, imagem intermediaria.
- `_high`: CDN `/b/`, alta definicao.
- `_original`: CDN `/o/`, maior imagem encontrada.

## 3. Ajustar velocidade

Padrao conservador:

```powershell
node scraper.js --delay-min 4500 --delay-max 9000 --page-pause-every 8 --page-pause-min 45000 --page-pause-max 120000
```

Mais lento:

```powershell
node scraper.js --delay-min 10000 --delay-max 20000 --page-pause-every 5 --page-pause-min 120000 --page-pause-max 300000
```

## 4. Reprocessar imagens faltantes

```powershell
node scraper.js --refresh
node build-catalog.js
```

Use `--refresh-links` quando quiser redescobrir as listas de uma operadora.

## 5. Opcoes uteis

- `--operadora "Embratel"`: processa somente operadoras cujo nome contenha o texto.
- `--limite 100`: limita a quantidade de cartoes por operadora.
- `--sem-imagens`: salva apenas dados.
- `--sem-high`: baixa somente imagem normal, sem a versao `_high`.
- `--refresh`: reprocessa dados e imagens existentes.
- `--refresh-links`: baixa novamente as paginas de listagem.
- `--aguardar-login`: pausa apos abrir o browser para voce fazer login manual no Colnect antes de comecar o scraping. Necessario para baixar imagens protegidas.

## 6. Corrigir imagens bloqueadas ja baixadas

Após rodar o scraper, algumas imagens podem ter sido salvas como placeholder (retangulo preto). Para detectar e corrigir:

```powershell
# Ver quais seriam afetadas (sem apagar nada)
node fix-blocked-images.js

# Apagar os placeholders e atualizar os cartoes
node fix-blocked-images.js --fix
```

Os cartoes afetados ficam registrados em `_imagens_bloqueadas.json`. Para baixar as imagens corretas, rode o scraper com login:

```powershell
node scraper.js --aguardar-login --refresh
```
