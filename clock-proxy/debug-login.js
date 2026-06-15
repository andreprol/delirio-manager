require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');

const ip = process.argv[2] || '192.168.15.151';
const executablePath = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const user = process.env.CLOCK_USER;
const pass = process.env.CLOCK_PASS;

const OUT = 'C:\\DtClockProxy\\debug';
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const shot = (page, name) => page.screenshot({ path: `${OUT}\\${name}.png`, fullPage: true });
const dump = (page, name) => page.content().then(h => fs.writeFileSync(`${OUT}\\${name}.html`, h, 'utf8'));

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage();

  console.log('[1] Login...');
  await page.goto(`http://${ip}`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => {
    const n = document.querySelector('form[name="rsa"] input[name="n"]');
    return n && n.value.length > 0;
  }, { timeout: 30000 });
  await page.locator('#lblLogin').fill(user);
  await page.locator('#lblPass').fill(pass);
  await page.locator('a.button.primary', { hasText: 'Entrar' }).click();
  await page.waitForSelector('text=Colaboradores', { timeout: 30000 });
  console.log('[1] Login OK');

  console.log('[2] Colaboradores → Inserir...');
  await page.getByText('Colaboradores').click();
  await page.waitForSelector('a:has-text("Inserir")', { timeout: 10000 });
  await page.locator('a:has-text("Inserir")').click();
  await page.waitForSelector('text=Verificação de digital', { timeout: 10000 });
  console.log('[2] Formulário de inserção aberto');
  await shot(page, '01_form_antes_fill');

  // Estado do checkbox de biometria
  const bioChecked = await page.locator('#chkVerifyBio').isChecked().catch(() => null);
  console.log(`[2] chkVerifyBio marcado: ${bioChecked}`);

  console.log('[3] Preenchendo campos...');
  await page.locator('#lblName').fill('PROX DEBUG');
  await page.locator('#lblCpf').fill('803.243.720-78');      // formatado: xxx.xxx.xxx-xx
  await page.locator('#lblRegistration1').fill('9999');       // Referência 1 / matrícula (NOVO)
  await page.locator('#lblRegistration2').fill('16317550');   // Referência 2 / cartão NFC
  await page.locator('#lblPassword').fill('123456');          // Senha numérica (NOVO)
  await shot(page, '02_form_preenchido');

  console.log('[4] Clicando Salvar...');
  // Listar todos os botões Salvar
  const salvars = await page.locator('a:has-text("Salvar"), button:has-text("Salvar")').all();
  console.log(`    Botões Salvar encontrados: ${salvars.length}`);
  for (let i = 0; i < salvars.length; i++) {
    const txt = await salvars[i].textContent();
    const vis = await salvars[i].isVisible();
    console.log(`    [${i}] "${txt?.trim()}" visible=${vis}`);
  }

  await page.locator('a:has-text("Salvar"), button:has-text("Salvar")').click();
  await page.waitForTimeout(4000);

  await shot(page, '03_pos_salvar');
  await dump(page, '03_pos_salvar');
  console.log('[4] Screenshot 03_pos_salvar salvo');

  // O que está visível após salvar?
  const texts = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('td, div, span, h4, label, a'))
      .filter(el => el.offsetWidth > 0 && el.offsetHeight > 0 && el.childElementCount === 0)
      .map(el => el.textContent.trim())
      .filter(t => t.length > 0 && t.length < 100);
  });
  console.log('[4] Textos após Salvar:', JSON.stringify([...new Set(texts)].slice(0, 30), null, 2));

  // Verifica se ainda tem Inserir/Excluir/Salvar
  const hasInserir  = await page.locator('a:has-text("Inserir")').isVisible().catch(() => false);
  const hasExcluir  = await page.locator('a:has-text("Excluir")').isVisible().catch(() => false);
  const hasSalvar   = await page.locator('a:has-text("Salvar")').isVisible().catch(() => false);
  const hasColabList = await page.locator('tr.painted, tr.unpainted').count().catch(() => 0);
  console.log(`[4] Inserir visível: ${hasInserir}`);
  console.log(`[4] Excluir visível: ${hasExcluir}`);
  console.log(`[4] Salvar visível:  ${hasSalvar}`);
  console.log(`[4] Linhas de colaboradores: ${hasColabList}`);

  await browser.close();
  console.log(`\nArquivos em ${OUT}`);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
