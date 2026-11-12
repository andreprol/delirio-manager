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
