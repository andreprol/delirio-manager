package main

// vkLWin/vkRWin: mesmos codigos que o resto do projeto ja usa pra tecla
// Windows (ver dashboard/src/components/LiveSessionWindow.jsx, VK_LWIN/
// VK_RWIN) -- 0x5B/0x5C, iguais ao Win32 VK_LWIN/VK_RWIN e ao keyCode que o
// navegador reporta pra essas teclas.
const (
	vkLWin = 0x5B
	vkRWin = 0x5C
)

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
			return true, event
		}
		if !s.winDown {
			s.winDown = true
			s.comboFired = false
		}
		return true, ""
	}

	if !s.winDown {
		// Tecla normal, Win não pressionado -- não é nosso assunto, nunca
		// suprime.
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
	if name, ok := supportedCombos[vk]; ok {
		return true, name
	}
	return true, ""
}
