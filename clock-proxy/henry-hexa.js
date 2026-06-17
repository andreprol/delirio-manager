const { chromium } = require('playwright');
const http = require('http');

class HenryHexa {
  constructor(ip, user, password) {
    this.ip = ip;
    this.user = user;
    this.password = password;
    this.baseUrl = `http://${ip}`;
  }

  async withBrowser(fn) {
    const executablePath = process.env.CHROME_PATH ||
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const browser = await chromium.launch({ headless: true, executablePath });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      return await fn(page);
    } finally {
      await browser.close();
    }
  }

  // Verifica se o relógio está acessível na rede sem iniciar browser
  // Faz GET HTTP simples com timeout de 5 segundos
  async checkReachable() {
    const start = Date.now();
    return new Promise((resolve) => {
      const req = http.get(this.baseUrl, { timeout: 5000 }, (res) => {
        res.resume(); // descarta o body
        resolve({ reachable: true, responseTimeMs: Date.now() - start, statusCode: res.statusCode });
      });
      req.on('error', (err) => {
        resolve({ reachable: false, responseTimeMs: Date.now() - start, error: err.message });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({ reachable: false, responseTimeMs: Date.now() - start, error: 'timeout' });
      });
    });
  }

  async login(page) {
    await page.goto(this.baseUrl, { waitUntil: 'load', timeout: 30000 });
    // Aguarda o relógio buscar a chave RSA pública antes de enviar credenciais
    await page.waitForFunction(() => {
      const n = document.querySelector('form[name="rsa"] input[name="n"]');
      return n && n.value.length > 0;
    }, { timeout: 30000 });
    await page.locator('#lblLogin').fill(this.user);
    await page.locator('#lblPass').fill(this.password);
    await page.locator('a.button.primary', { hasText: 'Entrar' }).click();
    await page.waitForSelector('text=Colaboradores', { timeout: 30000 });
  }

  // Navega para a tela de lista de colaboradores (usado apenas pelo listEmployees)
  async navigateToColaborador(page) {
    await page.getByText('Colaboradores').click();
    await page.waitForSelector('text=Buscar', { timeout: 10000 });
  }

  // Abre formulário de busca diretamente, sem esperar a lista de 300+ funcionários carregar
  async navigateAndSearchByCPF(page, cpf) {
    const cpfDigits = cpf.replace(/\D/g, '').slice(0, 11);
    const formattedCpf = cpfDigits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');

    await page.getByText('Colaboradores').click();
    // Aguarda o botão "Inserir" — exclusivo da página de Colaboradores, nunca presente no menu principal
    await page.waitForSelector('a:has-text("Inserir")', { timeout: 10000 });

    // Clica Buscar para abrir o formulário de pesquisa
    await page.locator('a:has-text("Buscar")').click();
    await page.waitForSelector('text=Informe um dos campos', { timeout: 10000 });

    // Campo aceita maxlength=14 — preenche com CPF formatado (xxx.xxx.xxx-xx)
    await page.locator('#lblCpf').fill(formattedCpf);
    await page.locator('a:has-text("Buscar"), button:has-text("Buscar")').last().click();
    await page.waitForTimeout(3000);

    // Busca por CPF único auto-navega para a página de detalhes do funcionário.
    // "Excluir" só aparece nessa página — sua presença confirma que o funcionário foi encontrado.
    const found = await page.locator('a:has-text("Excluir")').isVisible().catch(() => false);
    return { found, formattedCpf };
  }

  // Remove funcionário do relógio (biometria + Ref1 + Ref2 + cadastro)
  async deleteEmployee(cpf) {
    const timestamp = new Date().toISOString();

    return await this.withBrowser(async (page) => {
      try {
        await this.login(page);

        const { found, formattedCpf } = await this.navigateAndSearchByCPF(page, cpf);
        if (!found) {
          return {
            success: false,
            alreadyAbsent: true,
            message: `CPF ${cpf} não encontrado no relógio — pode já ter sido removido`,
            timestamp,
            clockIp: this.ip,
          };
        }

        // Já na página de detalhes — clica Excluir diretamente
        page.once('dialog', dialog => dialog.accept());
        await page.locator('a:has-text("Excluir")').click();
        await page.waitForTimeout(2000);

        // Se "Excluir" ainda visível, a remoção falhou
        const stillOnDetail = await page.locator('a:has-text("Excluir")').isVisible().catch(() => false);
        if (stillOnDetail) {
          return {
            success: false,
            message: 'Funcionário ainda presente após tentativa de exclusão',
            timestamp,
            clockIp: this.ip,
          };
        }

        return {
          success: true,
          message: `Funcionário removido do relógio ${this.ip}`,
          timestamp,
          clockIp: this.ip,
        };

      } catch (err) {
        return {
          success: false,
          message: `Erro Playwright: ${err.message}`,
          timestamp,
          clockIp: this.ip,
        };
      }
    });
  }

  // Cadastra funcionário no relógio
  // ref1 (matrícula) é obrigatório pelo relógio — o save retorna "Parâmetros inválidos" sem ele
  // password é o PIN numérico do funcionário no relógio (opcional, mas recomendado)
  async enrollEmployee({ cpf, name, ref1, ref2, password }) {
    const timestamp = new Date().toISOString();

    return await this.withBrowser(async (page) => {
      try {
        await this.login(page);

        await page.getByText('Colaboradores').click();
        await page.waitForSelector('a:has-text("Inserir")', { timeout: 10000 });

        await page.locator('a:has-text("Inserir")').click();
        await page.waitForSelector('text=Verificação de digital', { timeout: 10000 });

        await page.locator('#lblName').fill(name.toUpperCase().slice(0, 52));

        const cpfDigits = cpf.replace(/\D/g, '').slice(0, 11);
        const formattedCpf = cpfDigits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
        await page.locator('#lblCpf').fill(formattedCpf);

        if (ref1) {
          await page.locator('#lblRegistration1').fill(String(ref1).slice(0, 20));
        }
        if (ref2) {
          await page.locator('#lblRegistration2').fill(String(ref2).slice(0, 20));
        }
        if (password) {
          await page.locator('#lblPassword').fill(String(password).slice(0, 6));
        }

        await page.locator('a:has-text("Salvar"), button:has-text("Salvar")').click();
        await page.waitForTimeout(3000);

        // Verificar resultado real: "Sucesso ao salvar" = OK; "inválidos" = erro de validação
        const pageTexts = await page.evaluate(() =>
          Array.from(document.querySelectorAll('td, div, span, h4, label'))
            .filter(el => el.offsetWidth > 0 && el.offsetHeight > 0 && el.childElementCount === 0)
            .map(el => el.textContent.trim())
            .filter(t => t.length > 0)
        );

        const saved = pageTexts.some(t => t.includes('Sucesso ao salvar'));
        const errorMsg = pageTexts.find(t => t.includes('inválidos') || t.includes('obrigatório'));

        if (!saved) {
          return {
            success: false,
            message: errorMsg || 'Salvar não confirmado — verifique os parâmetros enviados',
            timestamp,
            clockIp: this.ip,
          };
        }

        return {
          success: true,
          message: `Funcionário cadastrado no relógio ${this.ip}`,
          timestamp,
          clockIp: this.ip,
        };

      } catch (err) {
        return {
          success: false,
          message: `Erro Playwright: ${err.message}`,
          timestamp,
          clockIp: this.ip,
        };
      }
    });
  }

  // Atualiza somente a Referência 2 (número do cartão NFC) de um funcionário
  async updateCardRef2(cpf, newRef2) {
    const timestamp = new Date().toISOString();

    return await this.withBrowser(async (page) => {
      try {
        await this.login(page);

        const { found, formattedCpf } = await this.navigateAndSearchByCPF(page, cpf);
        if (!found) {
          return { success: false, message: `CPF ${cpf} não encontrado`, timestamp, clockIp: this.ip };
        }

        // Já na página de detalhes/edição — preenche Referência 2 diretamente
        await page.locator('#lblRegistration2').fill(String(newRef2).slice(0, 20));
        await page.locator('a:has-text("Salvar"), button:has-text("Salvar")').click();
        await page.waitForTimeout(2000);

        return {
          success: true,
          message: `Ref2 atualizada no relógio ${this.ip}`,
          timestamp,
          clockIp: this.ip,
        };

      } catch (err) {
        return {
          success: false,
          message: `Erro Playwright: ${err.message}`,
          timestamp,
          clockIp: this.ip,
        };
      }
    });
  }

  // Lista todos os funcionários do relógio (percorre paginação)
  // Colunas da tabela Henry Hexa ADV: Name | CPF | Ref1 | Ref2 | ...
  async listEmployees() {
    return await this.withBrowser(async (page) => {
      try {
        await this.login(page);
        await this.navigateToColaborador(page);

        const employees = [];
        const seenCpfs = new Set(); // deduplicação dentro do mesmo relógio
        let pageNum = 1;

        while (true) {
          // Aguarda as linhas estarem presentes antes de ler
          await page.waitForSelector('tr.painted, tr.unpainted', { timeout: 15000 }).catch(() => {});

          const rows = await page.locator('tr.painted, tr.unpainted').all();

          // Captura texto da primeira linha ANTES de clicar próxima página
          // (usado para detectar quando a página realmente mudou)
          const firstRowText = rows.length > 0
            ? (await rows[0].locator('td').first().textContent().catch(() => '')).trim()
            : '';

          for (const row of rows) {
            const cells = await row.locator('td').all();
            if (cells.length < 2) continue;
            const name = (await cells[0].textContent() || '').trim();
            const cpf  = (await cells[1].textContent() || '').trim();
            if (!name || !cpf || seenCpfs.has(cpf)) continue;
            // Henry Hexa ADV list: 3 colunas (Name, CPF, Refs).
            // cells[2] contém Ref1 e Ref2 CONCATENADOS sem separador, cada um zero-padded
            // até 20 chars → total 40 chars quando ambos preenchidos.
            // Ex: "000000000028979833930000000000619978613" = Ref1(20) + Ref2(20)
            const refsRaw = cells.length > 2 ? (await cells[2].textContent() || '').trim() : '';
            const stripped = refsRaw.replace(/\s/g, '');
            let ref1 = stripped, ref2 = '';

            // Primary: 40-char concat Ref1(20)+Ref2(20) — split FIRST before any other check
            if (stripped.length > 20) {
              ref1 = stripped.slice(0, 20);
              ref2 = stripped.slice(20);
            }
            // Fallback: "Ref1 / Ref2" slash-separated
            if (!ref2 && refsRaw.includes('/')) {
              const parts = refsRaw.split('/').map(s => s.replace(/\s/g, ''));
              ref1 = parts[0] || ref1;
              ref2 = parts[1] || '';
            }
            // Last resort: separate Ref2 column (cells[3]) — only if numeric and 8+ chars
            // to avoid fingerprint counts, dates, or other non-ref2 fields
            if (!ref2 && cells.length > 3) {
              const r = (await cells[3].textContent() || '').replace(/\s/g, '');
              if (r.length >= 8 && /^\d+$/.test(r)) ref2 = r;
            }
            seenCpfs.add(cpf);
            employees.push({ name, cpf, ref1, ref2 });
          }

          pageNum++;
          const nextLink = page.locator('a').filter({ hasText: String(pageNum) });
          if (!(await nextLink.isVisible().catch(() => false))) break;

          await nextLink.click();

          // Espera determinística: aguarda o conteúdo da primeira linha mudar,
          // garantindo que o servidor do relógio terminou de renderizar a nova página.
          try {
            await page.waitForFunction(
              (prev) => {
                const firstRow = document.querySelector('tr.painted, tr.unpainted');
                if (!firstRow) return false;
                const firstCell = firstRow.querySelector('td');
                return firstCell && firstCell.textContent.trim() !== prev;
              },
              firstRowText,
              { timeout: 20000 }
            );
          } catch {
            // Timeout aguardando mudança de página — encerra paginação
            break;
          }
          await page.waitForTimeout(300); // buffer mínimo para restante do DOM renderizar
        }

        return { success: true, employees, total: employees.length, clockIp: this.ip };

      } catch (err) {
        return { success: false, message: err.message, employees: [], clockIp: this.ip };
      }
    });
  }

  async debugListEmployees() {
    return await this.withBrowser(async (page) => {
      try {
        await this.login(page);
        await this.navigateToColaborador(page);
        await page.waitForSelector('tr.painted, tr.unpainted', { timeout: 15000 }).catch(() => {});
        const rows = await page.locator('tr.painted, tr.unpainted').all();
        const sampleRows = [];
        for (const row of rows.slice(0, 5)) {
          const cells = await row.locator('td').all();
          const cellData = [];
          for (const cell of cells) {
            const text = (await cell.textContent() || '').trim();
            cellData.push({ text, strippedLen: text.replace(/\s/g, '').length });
          }
          sampleRows.push({ cellCount: cells.length, cells: cellData });
        }
        return { success: true, sampleRows, totalRows: rows.length, clockIp: this.ip };
      } catch (err) {
        return { success: false, message: err.message, clockIp: this.ip };
      }
    });
  }
}

module.exports = { HenryHexa };
