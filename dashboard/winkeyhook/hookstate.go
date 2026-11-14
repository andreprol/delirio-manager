package main

// vkLWin/vkRWin: mesmos codigos que o resto do projeto ja usa pra tecla
// Windows (ver dashboard/src/components/LiveSessionWindow.jsx, VK_LWIN/
// VK_RWIN) -- 0x5B/0x5C, iguais ao Win32 VK_LWIN/VK_RWIN e ao keyCode que o
// navegador reporta pra essas teclas.
const (
	vkLWin = 0x5B
	vkRWin = 0x5C

	// vkShift/vkLShift/vkRShift: mesmo trio que EMERGENCY_RELEASE_KEYCODES
	// já trata como "é a tecla Shift" em LiveSessionWindow.jsx -- um hook
	// de baixo nível (WH_KEYBOARD_LL) entrega o VK já distinguido por
	// lado (0xA0/0xA1), nunca o genérico 0x10 que as APIs de mensagem
	// (WM_KEYDOWN) sintetizam; mantemos 0x10 só como fallback defensivo.
	vkShift  = 0x10
	vkLShift = 0xA0
	vkRShift = 0xA1
)

func isShiftKey(vk uint32) bool {
	return vk == vkShift || vk == vkLShift || vk == vkRShift
}

// supportedCombos: so estas combinacoes Win+<tecla> sao interceptadas e
// repassadas pro processo pai (ver main.go) -- qualquer outro Win+<tecla>
// fica sem efeito nem local nem remoto enquanto o hook estiver ativo
// (trade-off deliberado, documentado na conversa com Andre 12/11/2026:
// o hook so roda enquanto uma janela de sessao Normal tem foco, e so vale
// a pena pra suporte remoto de loja -- nao pra uso geral do PC do
// operador). R/E/D cobrem os atalhos mais uteis de suporte remoto
// (Executar/Explorador/Area de trabalho); Win+L nunca entra aqui -- trava
// a tela e protegido pelo proprio Windows, suprimir o keydown so impede o
// bloqueio local, nao da pra reivindicar a ACAO de travar (LockWorkStation
// chamada direto pelo proprio shell, fora do alcance de qualquer hook de
// teclado).
var supportedCombos = map[uint32]string{
	0x52: "win+r", // VK_R
	0x45: "win+e", // VK_E
	0x44: "win+d", // VK_D
}

// supportedShiftCombos: combos Win+Shift+<tecla> -- precisam da tecla Shift
// rastreada à parte (ver HookState.shiftActive) porque o slot comboKeyDown só
// guarda UMA tecla de ação por vez; Shift em si nunca ocupa esse slot (ver
// Handle). Hoje só Win+Shift+S (recorte de tela, Ferramenta de Captura),
// pedido explícito do André (item de pendência do Acesso Remoto, 13/11/2026)
// -- Win+S sozinho (sem Shift) continua não suportado de propósito.
var supportedShiftCombos = map[uint32]string{
	0x53: "win+shift+s", // VK_S
}

// HookState e a logica PURA de decisao do hook de baixo nivel -- testavel
// sem SetWindowsHookEx real (ver main.go, que so chama Handle a partir do
// callback de verdade). Decide, pra cada evento de tecla que o hook ve
// ANTES de qualquer outro processo no Windows, se deve suprimir (nunca
// deixar o SO/Explorer processar) e qual evento (se algum) reportar pro
// processo pai via stdout.
//
// Suprime o keydown da tecla Windows incondicionalmente, assim que
// pressionada -- o hook decide por evento, sem poder "esperar pra ver" se
// vai ser um toque solto ou um combo (contrato sincrono do Win32). Por
// isso o toque solto só é reportado no KEYUP, se nenhuma outra tecla tiver
// sido pressionada enquanto Win estava para baixo.
type HookState struct {
	winDown      bool
	comboFired   bool
	comboKeyDown uint32 // VK da tecla de combo atualmente pressionada; 0 = nenhuma
	// lShiftDown/rShiftDown: lados RASTREADOS SEPARADOS -- achado real do
	// code-reviewer (14/11/2026, com teste de repro): um bool único
	// `shiftDown` setado por QUALQUER vk de Shift (`s.shiftDown =
	// !isKeyUp`) ficava "clobbered" se o operador segurasse os dois Shifts
	// e soltasse só um (ex: LShift down, RShift down, LShift up -> bool
	// único virava false mesmo com RShift ainda fisicamente pressionado),
	// perdendo o combo bem no meio do Win+Shift+S. shiftActive() abaixo é
	// o OR dos dois lados.
	lShiftDown bool
	rShiftDown bool
}

// shiftActive reporta se Shift (qualquer lado) está pressionado agora --
// único ponto que a tecla de ação consulta pra escolher entre
// supportedCombos/supportedShiftCombos.
func (s *HookState) shiftActive() bool {
	return s.lShiftDown || s.rShiftDown
}

// Handle processa 1 evento de tecla (vk, isKeyUp) e devolve se deve
// suprimir (nunca repassar pro Windows) e qual evento reportar ("" = nada
// a reportar).
//
// Achado real do code-reviewer (12/11/2026): o Windows gera keydown
// REPETIDO (auto-repeat) pra qualquer tecla mantida fisicamente
// pressionada, incluindo Win e a tecla do combo -- KBDLLHOOKSTRUCT não
// expõe o bit de "tecla já estava pressionada" do lParam clássico de
// WM_KEYDOWN, então um repeat chega IDÊNTICO a um keydown novo. Sem
// distinguir isso, 2 bugs reais: (1) um repeat de Win depois de um combo
// já disparado resetava comboFired, fazendo o keyup final de Win reportar
// "win-tap" espúrio por cima do combo (Menu Iniciar abrindo no remoto
// DEPOIS do Executar já ter aberto); (2) um repeat da tecla do combo
// (segurar Win+R) re-disparava a sequência completa a cada tick de
// repeat, reabrindo o Executar em loop enquanto a combinação ficasse
// pressionada. Os 2 só são corrigidos tratando cada "down" como evento
// só na BORDA DE SUBIDA (estado ainda não marcado como pressionado) --
// repeats seguintes são suprimidos (nunca deixa a tecla vazar pro
// Windows) mas não alteram nenhum estado nem reportam nada de novo.
func (s *HookState) Handle(vk uint32, isKeyUp bool) (suppress bool, event string) {
	if vk == vkLWin || vk == vkRWin {
		if isKeyUp {
			if s.winDown && !s.comboFired {
				event = "win-tap"
			}
			s.winDown = false
			s.comboFired = false
			// lShiftDown/rShiftDown zeram aqui mesmo (diferente de
			// comboKeyDown abaixo) -- não existe cenário análogo ao bug de
			// 13/11 pra Shift: Shift nunca é "a" tecla reportada (só
			// modifica qual nome sai de supportedShiftCombos), então deixar
			// o keyup real dela escapar pro Windows depois de Win solto
			// primeiro é inofensivo (nenhuma combinação foi suprimida
			// esperando esse keyup específico).
			s.lShiftDown = false
			s.rShiftDown = false
			// NÃO zera s.comboKeyDown aqui -- achado 🔴 CRÍTICO do code-reviewer
			// (13/11/2026): zerar cedo faz o keyup da tecla do combo, quando
			// ainda chega depois (Win solto ANTES da tecla do combo -- ordem
			// física comum, Win sai do mindinho primeiro), cair no guard
			// `!s.winDown` abaixo e devolver suppress=false -- vazando esse
			// keyup pro Windows de verdade (main.go: suppress=false chama
			// CallNextHookEx). O reset correto continua condicionado ao guard
			// abaixo (comboKeyDown != vk), que deixa o keyup da PRÓPRIA tecla
			// do combo passar e se resetar sozinho (linhas 114-117), mesmo com
			// winDown já false.
			return true, event
		}
		if !s.winDown {
			s.winDown = true
			s.comboFired = false
		}
		return true, ""
	}

	if !s.winDown && s.comboKeyDown != vk {
		// Tecla normal, Win não pressionado -- não é nosso assunto, nunca
		// suprime. Excessão: a PRÓPRIA tecla do combo ainda pendente de
		// keyup/repeat depois de Win ter sido solto primeiro (comboKeyDown ==
		// vk) continua suprimida e processada abaixo, só pra poder se resetar
		// -- ver comentário no keyup de Win acima.
		return false, ""
	}

	// Win está pressionado -- qualquer outra tecla aqui marca "não foi um
	// toque solto" (mesmo as não suportadas, ver comentário de
	// supportedCombos acima) e é suprimida: o keydown do Win já foi
	// engolido, deixar esta tecla passar sozinha pro Windows geraria
	// comportamento local parcial/estranho (ex: "S" de Win+S virando só
	// "S" digitado em algum app, sem o modificador Win nunca ter existido
	// do ponto de vista do SO).
	s.comboFired = true

	// Shift é só o MODIFICADOR do combo, nunca "a" tecla de ação -- não
	// ocupa o slot comboKeyDown (que guarda só 1 tecla por vez), senão um
	// Win+Shift+S perderia o rastreamento de Shift assim que S fosse
	// pressionado (S tomaria o slot). Nenhum evento é reportado aqui por
	// conta própria -- só muda qual mapa (supportedShiftCombos vs.
	// supportedCombos) a tecla de ação abaixo vai consultar.
	if isShiftKey(vk) {
		if vk == vkRShift {
			s.rShiftDown = !isKeyUp
		} else { // vkLShift ou vkShift genérico (fallback, ver const) -- lado esquerdo
			s.lShiftDown = !isKeyUp
		}
		return true, ""
	}

	if isKeyUp {
		if s.comboKeyDown == vk {
			s.comboKeyDown = 0
		}
		return true, ""
	}
	if s.comboKeyDown == vk {
		return true, "" // repeat da tecla do combo -- já reportado na borda de subida
	}
	s.comboKeyDown = vk
	combos := supportedCombos
	if s.shiftActive() {
		combos = supportedShiftCombos
	}
	if name, ok := combos[vk]; ok {
		return true, name
	}
	return true, ""
}
