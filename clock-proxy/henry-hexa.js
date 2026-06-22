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

    // Aguarda "Colaboradores" (sucesso) ou tela de sessão ativa (requer desconexão forçada)
    let loggedIn = false;
    try {
      await Promise.race([
        page.waitForSelector('text=Colaboradores',     { timeout: 30000 }).then(() => { loggedIn = true; }),
        page.waitForSelector('text=Outra conexão',     { timeout: 30000 }),
        page.waitForSelector('text=outra conexão',     { timeout: 30000 }),
        page.waitForSelector('text=conexão ativa',     { timeout: 30000 }),
        page.waitForSelector('text=sessão ativa',      { timeout: 30000 }),
      ]);
    } catch {
      // nenhum dos seletores apareceu — captura estado atual
    }

    if (!loggedIn) {
      // Verifica se é tela de "Outra conexão está ativa" e tenta forçar desconexão
      const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
      const isSessionConflict = /outra conex|conex.*ativa|sess.*ativa/i.test(bodyText);

      if (isSessionConflict) {
        // Henry Hexa exibe botão "Continuar" ou "Desconectar" para forçar logout da sessão anterior
        const forceBtn = page.locator('a, button').filter({
          hasText: /Continuar|Desconectar|Forçar|Forcar/i,
        }).first();
        if (await forceBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          await forceBtn.click();
          await page.waitForSelector('text=Colaboradores', { timeout: 30000 });
          return; // login OK após forçar desconexão
        }
        throw new Error(`Outra conexão está ativa no relógio — não foi possível forçar desconexão (botão não encontrado)`);
      }

      // Falha genérica de login
      const visibleText = await page.evaluate(() =>
        Array.from(document.querySelectorAll('div, span, h4, label, p, td, input'))
          .filter(el => el.offsetWidth > 0 && el.offsetHeight > 0 && el.childElementCount === 0)
          .map(el => (el.value || el.textContent || '').trim())
          .filter(t => t.length > 2)
          .slice(0, 10)
          .join(' | ')
      ).catch(() => 'não foi possível capturar texto');
      throw new Error(`Login falhou — "Colaboradores" não apareceu após 30s. Tela após Entrar: "${visibleText}"`);
    }
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

    // Captura texto da página quando não encontrado — ajuda a diagnosticar bugs de firmware
    let pageText = '';
    if (!found) {
      pageText = await page.evaluate(() =>
        Array.from(document.querySelectorAll('td, div, span, h4, label'))
          .filter(el => el.offsetWidth > 0 && el.offsetHeight > 0 && el.childElementCount === 0)
          .map(el => el.textContent.trim())
          .filter(t => t.length > 2)
          .slice(0, 8)
          .join(' | ')
      ).catch(() => '');
    }

    return { found, formattedCpf, pageText };
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
        // Aguarda o campo Nome — presente em todos os firmwares do Hexa ADV
        // (evita depender do texto "Verificação de digital" que varia por versão)
        await page.waitForSelector('#lblName', { timeout: 30000 });

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

        // Captura flag de sucesso imediatamente ao detectar o texto — antes de qualquer redirect.
        // Henry Hexa pode exibir "Sucesso ao salvar" por <1s antes de navegar para formulário vazio,
        // fazendo page.evaluate() posterior capturar página em branco.
        let savedEarly = false;
        try {
          await Promise.race([
            page.waitForSelector('text=Sucesso ao salvar', { timeout: 10000 })
              .then(() => { savedEarly = true; }),
            page.waitForSelector('text=já cadastrado',     { timeout: 10000 }),
            page.waitForSelector('text=já cadastrada',     { timeout: 10000 }),
            page.waitForSelector('text=inválidos',         { timeout: 10000 }),
            page.waitForSelector('text=obrigatório',       { timeout: 10000 }),
          ]);
        } catch { /* timeout — avalia o estado atual da página */ }

        const pageTexts = await page.evaluate(() =>
          Array.from(document.querySelectorAll('td, div, span, h4, label'))
            .filter(el => el.offsetWidth > 0 && el.offsetHeight > 0 && el.childElementCount === 0)
            .map(el => el.textContent.trim())
            .filter(t => t.length > 0)
        );

        const saved = savedEarly || pageTexts.some(t => t.includes('Sucesso ao salvar'));
        const alreadyReg = pageTexts.some(t =>
          t.includes('já cadastrado') || t.includes('já cadastrada') ||
          t.includes('já existe') || t.includes('duplicado') || t.includes('duplicada')
        );
        const errorMsg   = pageTexts.find(t =>
          t.includes('inválidos') || t.includes('obrigatório') || t.includes('Parâmetros')
        );

        if (alreadyReg) {
          // "já cadastrado" pode ser conflito de Ref1 (não de CPF) — verifica se o CPF
          // específico está realmente no relógio antes de declarar sucesso.
          let cpfReally = false;
          try {
            const check = await this.navigateAndSearchByCPF(page, cpf);
            cpfReally = check.found;
          } catch { cpfReally = false; }

          if (cpfReally) {
            return {
              success: true,
              message: `Funcionário já cadastrado no relógio ${this.ip}`,
              timestamp,
              clockIp: this.ip,
            };
          }
          // CPF ausente mas relógio diz "já cadastrado" → conflito de Ref1
          return {
            success: false,
            ref1Conflict: true,
            message: `Conflito de Ref1 (matrícula ${ref1?.replace(/^0+/, '') || '?'} já pertence a outro funcionário neste relógio) — altere o Ref1 deste funcionário`,
            timestamp,
            clockIp: this.ip,
          };
        }

        if (!saved) {
          const pageContext = pageTexts.filter(t => t.length > 3).slice(0, 6).join(' / ');
          return {
            success: false,
            message: `${errorMsg || 'Salvar não confirmado'} — tela: "${pageContext}"`,
            timestamp,
            clockIp: this.ip,
          };
        }

        // Verifica persistência: busca o CPF na lista após salvar.
        // Alguns firmwares exibem "Sucesso ao salvar" mas não persistem o registro.
        let verified = false;
        let verifyPageText = '';
        try {
          const check = await this.navigateAndSearchByCPF(page, cpf);
          verified      = check.found;
          verifyPageText = check.pageText || '';
        } catch {
          verified = true; // erro na verificação → confia no "Sucesso ao salvar"
        }

        if (!verified) {
          const detail = verifyPageText ? ` (pós-busca: "${verifyPageText}")` : '';
          return {
            success: false,
            message: `Relógio exibiu "Sucesso ao salvar" mas CPF não encontrado${detail} — bug no firmware: reinicie o relógio e tente novamente`,
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

        let savedEarly = false;
        try {
          await Promise.race([
            page.waitForSelector('text=Sucesso ao salvar', { timeout: 10000 })
              .then(() => { savedEarly = true; }),
            page.waitForSelector('text=inválidos',         { timeout: 10000 }),
            page.waitForSelector('text=obrigatório',       { timeout: 10000 }),
          ]);
        } catch { /* timeout — avalia estado atual */ }

        const pageTexts = await page.evaluate(() =>
          Array.from(document.querySelectorAll('td, div, span, h4, label'))
            .filter(el => el.offsetWidth > 0 && el.offsetHeight > 0 && el.childElementCount === 0)
            .map(el => el.textContent.trim())
            .filter(t => t.length > 0)
        );
        const saved = savedEarly || pageTexts.some(t => t.includes('Sucesso ao salvar'));
        const errorMsg = pageTexts.find(t => t.includes('inválidos') || t.includes('obrigatório'));

        if (!saved) {
          return {
            success: false,
            message: errorMsg || 'Salvar não confirmado — tente novamente',
            timestamp,
            clockIp: this.ip,
          };
        }

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

  // Aguarda a contagem de linhas ficar estável por `stableMs` consecutivos.
  // Garante que o firmware terminou de renderizar a página antes de ler.
  async _waitForStableRows(page, stableMs = 500, maxWaitMs = 15000) {
    const start    = Date.now();
    let lastCount  = -1;
    let stableSince = -1;

    while (Date.now() - start < maxWaitMs) {
      const count = await page.locator('tr.painted, tr.unpainted').count();
      if (count > 0 && count === lastCount) {
        if (stableSince < 0) stableSince = Date.now();
        if (Date.now() - stableSince >= stableMs) return count;
      } else {
        lastCount   = count;
        stableSince = count > 0 ? Date.now() : -1;
      }
      await page.waitForTimeout(300);
    }
    return lastCount > 0 ? lastCount : 0;
  }

  // Lista todos os funcionários do relógio (percorre paginação).
  // Usa espera por contagem estável em cada página para garantir leitura completa,
  // mesmo que o firmware do relógio seja lento para renderizar.
  async listEmployees() {
    return await this.withBrowser(async (page) => {
      try {
        await this.login(page);
        await this.navigateToColaborador(page);

        const employees = [];
        const seenCpfs  = new Set();
        let pageNum = 1;

        while (true) {
          // Aguarda contagem estável — o método verifica a cada 300ms até o número
          // de linhas não mudar por 1s consecutivo (ou timeout de 45s).
          const stableCount = await this._waitForStableRows(page);

          if (stableCount === 0) {
            if (pageNum === 1) {
              // Página 1 vazia após 45s — falha explícita para acionar guard no server.js
              return {
                success: false,
                message: 'Página de funcionários carregou vazia após 45s — possível lentidão do firmware',
                employees: [],
                total: 0,
                clockIp: this.ip,
              };
            }
            // Páginas seguintes vazias = fim da paginação
            break;
          }

          // Extrai TODOS os dados da página em uma única chamada JS — elimina N round-trips CDP.
          // Antes: ~4 chamadas CDP por linha × 20 linhas/pág = 80 chamadas/pág.
          // Agora: 1 chamada por página independente do número de linhas.
          const pageRows = await page.evaluate(() =>
            Array.from(document.querySelectorAll('tr.painted, tr.unpainted')).map(row => {
              const cells = Array.from(row.querySelectorAll('td'));
              if (cells.length < 2) return null;
              return [
                (cells[0]?.textContent || '').trim(),                    // name
                (cells[1]?.textContent || '').trim(),                    // cpf
                (cells[2]?.textContent || '').trim(),                    // refs (raw para check de '/')
                (cells[3]?.textContent || '').replace(/\s/g, ''),        // ref2 fallback (cells[3])
              ];
            }).filter(r => r !== null)
          );

          // Captura texto da primeira linha ANTES de clicar próxima página (para detecção de navegação)
          const firstRowText = pageRows.length > 0 ? pageRows[0][0] : '';

          for (const [name, cpf, refsRaw, ref2Cell3] of pageRows) {
            if (!name || !cpf || seenCpfs.has(cpf)) continue;

            // Henry Hexa ADV: cells[2] = Ref1+Ref2 concatenados (zero-padded 20+20 chars)
            const stripped = refsRaw.replace(/\s/g, '');
            let ref1 = stripped, ref2 = '';

            if (stripped.length > 20) {
              ref1 = stripped.slice(0, 20);
              ref2 = stripped.slice(20);
            }
            if (!ref2 && refsRaw.includes('/')) {
              const parts = refsRaw.split('/').map(s => s.replace(/\s/g, ''));
              ref1 = parts[0] || ref1;
              ref2 = parts[1] || '';
            }
            if (!ref2 && ref2Cell3.length >= 8 && /^\d+$/.test(ref2Cell3)) {
              ref2 = ref2Cell3;
            }

            seenCpfs.add(cpf);
            employees.push({ name, cpf, ref1, ref2 });
          }

          pageNum++;
          const nextLink = page.locator('a').filter({ hasText: String(pageNum) });
          if (!(await nextLink.isVisible().catch(() => false))) break;

          await nextLink.click();

          // Aguarda a primeira linha ser diferente da página anterior (navegação confirmada)
          try {
            await page.waitForFunction(
              (prev) => {
                const firstRow  = document.querySelector('tr.painted, tr.unpainted');
                if (!firstRow) return false;
                const firstCell = firstRow.querySelector('td');
                return firstCell && firstCell.textContent.trim() !== prev;
              },
              firstRowText,
              { timeout: 25000 }
            );
          } catch {
            break; // timeout na mudança de página — encerra paginação
          }
          // Não usa buffer fixo — _waitForStableRows no início do próximo ciclo cobre isso
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
