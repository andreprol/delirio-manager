package main

import "testing"

func TestHookStateBareWinTap(t *testing.T) {
	var s HookState

	suppress, event := s.Handle(vkLWin, false) // keydown
	if !suppress || event != "" {
		t.Fatalf("keydown Win: got (%v, %q), want (true, \"\")", suppress, event)
	}

	suppress, event = s.Handle(vkLWin, true) // keyup
	if !suppress || event != "win-tap" {
		t.Fatalf("keyup Win (toque solto): got (%v, %q), want (true, \"win-tap\")", suppress, event)
	}
}

func TestHookStateWinCombo(t *testing.T) {
	cases := []struct {
		name string
		vk   uint32
		want string
	}{
		{"Win+R", 0x52, "win+r"},
		{"Win+E", 0x45, "win+e"},
		{"Win+D", 0x44, "win+d"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var s HookState

			s.Handle(vkLWin, false) // Win down

			suppress, event := s.Handle(c.vk, false) // combo key down
			if !suppress || event != c.want {
				t.Fatalf("keydown %s: got (%v, %q), want (true, %q)", c.name, suppress, event, c.want)
			}

			suppress, event = s.Handle(c.vk, true) // combo key up
			if !suppress || event != "" {
				t.Fatalf("keyup %s (combo): got (%v, %q), want (true, \"\")", c.name, suppress, event)
			}

			// Win keyup depois de um combo já reportado NÃO deve mandar
			// "win-tap" de novo -- senão o remoto abriria o Menu Iniciar
			// depois de já ter aberto o Executar/Explorador/Desktop.
			suppress, event = s.Handle(vkLWin, true)
			if !suppress || event != "" {
				t.Fatalf("keyup Win após combo: got (%v, %q), want (true, \"\") -- não deveria reportar win-tap", suppress, event)
			}
		})
	}
}

// TestHookStateUnsupportedCombo: Win+S (não suportado) é suprimido (sem
// efeito local nem remoto), e o keyup de Win que segue NÃO reporta
// "win-tap" -- o operador quis um combo, mesmo que não suportado, não um
// toque solto.
func TestHookStateUnsupportedCombo(t *testing.T) {
	var s HookState
	const vkS = 0x53

	s.Handle(vkLWin, false)

	suppress, event := s.Handle(vkS, false)
	if !suppress || event != "" {
		t.Fatalf("keydown Win+S (não suportado): got (%v, %q), want (true, \"\")", suppress, event)
	}

	suppress, event = s.Handle(vkS, true)
	if !suppress || event != "" {
		t.Fatalf("keyup S: got (%v, %q), want (true, \"\")", suppress, event)
	}

	suppress, event = s.Handle(vkLWin, true)
	if !suppress || event != "" {
		t.Fatalf("keyup Win após Win+S: got (%v, %q), want (true, \"\") -- não deveria reportar win-tap", suppress, event)
	}
}

// TestHookStateRepeatComboAfterWinReleasedFirst: bug real reportado por André
// em produção (13/11/2026) -- soltar Win ANTES da tecla do combo (ordem
// física comum: Win sai do mindinho primeiro) deixava comboKeyDown preso no
// VK antigo, fazendo o MESMO combo repetido não disparar de novo (um combo
// DIFERENTE no meio "destravava" só por ter VK diferente, não por o estado
// estar correto). Todos os testes acima soltam a tecla do combo ANTES de
// Win -- nenhum cobria esta ordem, exatamente o gap que escondeu o bug.
func TestHookStateRepeatComboAfterWinReleasedFirst(t *testing.T) {
	var s HookState
	const vkR = 0x52

	pressAndReleaseWinFirst := func(n int) {
		suppress, event := s.Handle(vkLWin, false) // Win down
		if !suppress || event != "" {
			t.Fatalf("%dª vez, keydown Win: got (%v, %q), want (true, \"\")", n, suppress, event)
		}
		suppress, event = s.Handle(vkR, false) // R down -- é aqui que o evento "win+r" sai
		if !suppress || event != "win+r" {
			t.Fatalf("%dª vez, keydown R: got (%v, %q), want (true, \"win+r\")", n, suppress, event)
		}
		suppress, event = s.Handle(vkLWin, true) // Win up ANTES de R -- ordem que disparava o bug
		if !suppress || event != "" {
			t.Fatalf("%dª vez, keyup Win (antes de R): got (%v, %q), want (true, \"\")", n, suppress, event)
		}
		// Achado 🔴 CRÍTICO do code-reviewer: este keyup de R, chegando com
		// winDown já false, tem que CONTINUAR suprimido (suppress=true) --
		// um fix anterior que zerava comboKeyDown no keyup de Win fazia este
		// retorno virar (false, ""), vazando o keyup de R pro Windows real.
		suppress, event = s.Handle(vkR, true) // R up
		if !suppress || event != "" {
			t.Fatalf("%dª vez, keyup R (depois de Win): got (%v, %q), want (true, \"\") -- vazou pro Windows real?", n, suppress, event)
		}
	}

	pressAndReleaseWinFirst(1)
	pressAndReleaseWinFirst(2) // mesmo combo, repetido -- comboKeyDown preso de antes?
}

// TestHookStateNormalKeyNeverSuppressed: tecla comum, sem Win pressionado,
// nunca é suprimida -- o hook só se intromete quando Win está envolvido.
func TestHookStateNormalKeyNeverSuppressed(t *testing.T) {
	var s HookState
	const vkA = 0x41

	for _, isKeyUp := range []bool{false, true} {
		suppress, event := s.Handle(vkA, isKeyUp)
		if suppress || event != "" {
			t.Fatalf("tecla A (sem Win) isKeyUp=%v: got (%v, %q), want (false, \"\")", isKeyUp, suppress, event)
		}
	}
}

// TestHookStateConsecutiveTaps: 2 toques soltos em sequência -- estado
// zera corretamente entre um e outro, sem "vazar" comboFired do anterior.
func TestHookStateConsecutiveTaps(t *testing.T) {
	var s HookState

	s.Handle(vkLWin, false)
	_, event := s.Handle(vkLWin, true)
	if event != "win-tap" {
		t.Fatalf("1º toque: event = %q, want win-tap", event)
	}

	s.Handle(vkLWin, false)
	_, event = s.Handle(vkLWin, true)
	if event != "win-tap" {
		t.Fatalf("2º toque: event = %q, want win-tap (estado não zerou entre toques)", event)
	}
}

// TestHookStateKeyupWithoutKeydownNeverReportsTap: keyup de Win sem
// keydown correspondente visto antes (ex: hook começou a existir com Win
// já fisicamente pressionado) nunca reporta "win-tap" por engano.
func TestHookStateKeyupWithoutKeydownNeverReportsTap(t *testing.T) {
	var s HookState

	suppress, event := s.Handle(vkLWin, true)
	if !suppress || event != "" {
		t.Fatalf("keyup Win sem keydown visto: got (%v, %q), want (true, \"\")", suppress, event)
	}
}

// TestHookStateWinAutoRepeatAfterComboDoesNotReportSpuriousTap: achado real
// do code-reviewer (12/11/2026) -- segurar Win um pouco depois de soltar a
// tecla do combo gera auto-repeat do keydown de Win (SO continua mandando
// enquanto a tecla física está pressionada). Sem tratar isso como repeat
// (não como keydown novo), o keyup final de Win reportava "win-tap"
// espúrio DEPOIS de "win+r" já ter sido reportado -- um Win extra chegaria
// no remoto depois do Executar já ter aberto.
func TestHookStateWinAutoRepeatAfterComboDoesNotReportSpuriousTap(t *testing.T) {
	var s HookState

	s.Handle(vkLWin, false)        // Win down
	s.Handle(0x52, false)          // R down -- dispara "win+r"
	s.Handle(0x52, true)           // R up
	s.Handle(vkLWin, false)        // Win down DE NOVO -- auto-repeat, Win ainda fisicamente pressionado
	_, event := s.Handle(vkLWin, true) // Win up, finalmente solta

	if event != "" {
		t.Fatalf("keyup Win após repeat pós-combo: event = %q, want \"\" (não deveria reportar win-tap espúrio)", event)
	}
}

// TestHookStateComboKeyAutoRepeatDoesNotReReport: segurar Win+R gera
// keydown repetido da tecla R enquanto ela continua pressionada -- sem
// distinguir repeat de keydown novo, cada repeat re-disparava a sequência
// completa pro remoto, reabrindo o Executar em loop.
func TestHookStateComboKeyAutoRepeatDoesNotReReport(t *testing.T) {
	var s HookState

	s.Handle(vkLWin, false)
	_, firstEvent := s.Handle(0x52, false) // R down
	if firstEvent != "win+r" {
		t.Fatalf("1º keydown de R: event = %q, want win+r", firstEvent)
	}

	for i := 0; i < 3; i++ {
		suppress, event := s.Handle(0x52, false) // repeats de R, segurando
		if !suppress || event != "" {
			t.Fatalf("repeat %d de R: got (%v, %q), want (true, \"\") -- não deveria re-reportar win+r", i, suppress, event)
		}
	}

	suppress, event := s.Handle(0x52, true) // R up
	if !suppress || event != "" {
		t.Fatalf("keyup R: got (%v, %q), want (true, \"\")", suppress, event)
	}

	// Depois do R solto, um NOVO keydown de R (2º Win+R, mesma sessão de
	// Win pressionado) deve voltar a reportar -- não ficar presa achando
	// que ainda é repeat do primeiro.
	suppress, event = s.Handle(0x52, false)
	if !suppress || event != "win+r" {
		t.Fatalf("2º keydown de R após keyup: got (%v, %q), want (true, \"win+r\")", suppress, event)
	}
}

// TestHookStateWinShiftS: Win+Shift+S (recorte de tela) -- pedido do André,
// item de pendência do Acesso Remoto (13/11/2026). Shift precisa ser
// rastreado à parte do slot comboKeyDown (ver lShiftDown/rShiftDown) pra
// não perder o modificador assim que S é pressionado.
func TestHookStateWinShiftS(t *testing.T) {
	var s HookState
	const vkS = 0x53

	s.Handle(vkLWin, false) // Win down

	suppress, event := s.Handle(vkLShift, false) // Shift down
	if !suppress || event != "" {
		t.Fatalf("keydown Shift: got (%v, %q), want (true, \"\")", suppress, event)
	}

	suppress, event = s.Handle(vkS, false) // S down -- aqui sai o evento
	if !suppress || event != "win+shift+s" {
		t.Fatalf("keydown S com Shift: got (%v, %q), want (true, \"win+shift+s\")", suppress, event)
	}

	suppress, event = s.Handle(vkS, true) // S up
	if !suppress || event != "" {
		t.Fatalf("keyup S: got (%v, %q), want (true, \"\")", suppress, event)
	}

	suppress, event = s.Handle(vkLShift, true) // Shift up
	if !suppress || event != "" {
		t.Fatalf("keyup Shift: got (%v, %q), want (true, \"\")", suppress, event)
	}

	// Win solto por último não deve reportar "win-tap" -- um combo real
	// (com Shift) já disparou.
	suppress, event = s.Handle(vkLWin, true)
	if !suppress || event != "" {
		t.Fatalf("keyup Win após Win+Shift+S: got (%v, %q), want (true, \"\")", suppress, event)
	}
}

// TestHookStateWinShiftSTwiceInARow: a mesma combinação precisa voltar a
// funcionar numa 2ª vez -- mesmo gap de teste que achou o bug real de
// comboKeyDown preso (ver TestHookStateRepeatComboAfterWinReleasedFirst),
// agora aplicado ao par lShiftDown/comboKeyDown.
func TestHookStateWinShiftSTwiceInARow(t *testing.T) {
	var s HookState
	const vkS = 0x53

	pressAndRelease := func(n int) {
		s.Handle(vkLWin, false)
		s.Handle(vkLShift, false)
		_, event := s.Handle(vkS, false)
		if event != "win+shift+s" {
			t.Fatalf("%dª vez: event = %q, want win+shift+s", n, event)
		}
		s.Handle(vkS, true)
		s.Handle(vkLShift, true)
		s.Handle(vkLWin, true)
	}

	pressAndRelease(1)
	pressAndRelease(2)
}

// TestHookStateWinSWithoutShiftStillUnsupportedAfterShiftCombo: Win+S
// sozinho (sem Shift) continua sem efeito mesmo depois de Win+Shift+S já
// ter disparado antes na mesma sessão do hook -- lShiftDown não pode vazar
// de uma combinação pra outra.
func TestHookStateWinSWithoutShiftStillUnsupportedAfterShiftCombo(t *testing.T) {
	var s HookState
	const vkS = 0x53

	s.Handle(vkLWin, false)
	s.Handle(vkLShift, false)
	s.Handle(vkS, false)
	s.Handle(vkS, true)
	s.Handle(vkLShift, true)
	s.Handle(vkLWin, true)

	s.Handle(vkLWin, false)
	suppress, event := s.Handle(vkS, false)
	if !suppress || event != "" {
		t.Fatalf("Win+S sem Shift (após Win+Shift+S anterior): got (%v, %q), want (true, \"\") -- shiftDown vazou?", suppress, event)
	}
}

// TestHookStateBothShiftsHeldReleaseOneKeepsOtherTracked: bug real achado
// pelo code-reviewer (14/11/2026, com teste de repro) -- um bool único
// setado por QUALQUER vk de Shift zerava mesmo com o OUTRO lado ainda
// fisicamente pressionado (LShift down, RShift down, LShift up -> perdia
// o combo). lShiftDown/rShiftDown resolvem rastreando os 2 lados à parte.
func TestHookStateBothShiftsHeldReleaseOneKeepsOtherTracked(t *testing.T) {
	var s HookState
	const vkS = 0x53

	s.Handle(vkLWin, false)   // Win down
	s.Handle(vkLShift, false) // LShift down
	s.Handle(vkRShift, false) // RShift down (segurando os 2)
	s.Handle(vkLShift, true)  // solta só o LShift

	suppress, event := s.Handle(vkS, false) // S down -- RShift ainda pressionado
	if !suppress || event != "win+shift+s" {
		t.Fatalf("keydown S com RShift ainda pressionado: got (%v, %q), want (true, \"win+shift+s\") -- shiftActive() não deveria zerar só porque LShift soltou", suppress, event)
	}
}

// TestHookStateRWinSameAsLWin: VK_RWIN (Win direito) segue exatamente a
// mesma lógica que VK_LWIN -- o projeto já trata os dois como
// intercambiáveis em todo lugar (ver LiveSessionWindow.jsx).
func TestHookStateRWinSameAsLWin(t *testing.T) {
	var s HookState

	s.Handle(vkRWin, false)
	suppress, event := s.Handle(vkRWin, true)
	if !suppress || event != "win-tap" {
		t.Fatalf("toque solto com RWin: got (%v, %q), want (true, \"win-tap\")", suppress, event)
	}
}
