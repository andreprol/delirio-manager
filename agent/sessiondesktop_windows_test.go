package main

import (
	"errors"
	"sync"
	"testing"
)

// resetInteractiveWindowStationOnce: achado 🟡 do code-reviewer (rodada de
// verificação) -- nenhum teste exercitava o sync.Once de verdade
// (ensureInteractiveWindowStationFn mockado pulava essa lógica inteira).
// Reatribui um *NOVO* sync.Once (nunca copia o valor de um já existente --
// isso seria UB e o linter copylocks acusaria) antes de cada teste que
// precisa testar ensureInteractiveWindowStation diretamente, restaurando o
// original depois.
func resetInteractiveWindowStationOnce(t *testing.T) {
	t.Helper()
	origOnce, origErr := interactiveWindowStationOnce, interactiveWindowStationErr
	interactiveWindowStationOnce = &sync.Once{}
	interactiveWindowStationErr = nil
	t.Cleanup(func() {
		interactiveWindowStationOnce, interactiveWindowStationErr = origOnce, origErr
	})
}

// saveSessionDesktopMocks/restore: mesmo padrão de save/restore de vars
// mockáveis já usado no resto do pacote (ex: TestBrowseCallbackProc*,
// folderpicker_windows_test.go) -- evita vazar mock de um teste pro
// seguinte.
func withSessionDesktopMocks(t *testing.T, ensure func() error, open func() (uintptr, error), setThread func(uintptr) error, close_ func(uintptr)) {
	t.Helper()
	origEnsure, origOpen, origSetThread, origClose := ensureInteractiveWindowStationFn, openInputDesktopFn, setThreadDesktopFn, closeDesktopFn
	ensureInteractiveWindowStationFn, openInputDesktopFn, setThreadDesktopFn, closeDesktopFn = ensure, open, setThread, close_
	t.Cleanup(func() {
		ensureInteractiveWindowStationFn, openInputDesktopFn, setThreadDesktopFn, closeDesktopFn = origEnsure, origOpen, origSetThread, origClose
	})
}

func TestWithActiveDesktopRunsFnAfterSetThreadDesktopAndClosesHandle(t *testing.T) {
	const fakeHandle uintptr = 0xABCD
	var closedWith uintptr
	var fnRan bool

	withSessionDesktopMocks(t,
		func() error { return nil },
		func() (uintptr, error) { return fakeHandle, nil },
		func(h uintptr) error {
			if h != fakeHandle {
				t.Fatalf("SetThreadDesktop recebeu handle %v, esperava %v", h, fakeHandle)
			}
			return nil
		},
		func(h uintptr) { closedWith = h },
	)

	err := withActiveDesktop(func() error {
		fnRan = true
		return nil
	})

	if err != nil {
		t.Fatalf("esperava nil, veio %v", err)
	}
	if !fnRan {
		t.Fatal("fn nunca rodou")
	}
	if closedWith != fakeHandle {
		t.Fatalf("CloseDesktop recebeu %v, esperava %v", closedWith, fakeHandle)
	}
}

func TestWithActiveDesktopEnsureWindowStationFailsNeverOpensDesktop(t *testing.T) {
	wantErr := errors.New("sem permissao")
	var openCalled, fnCalled bool

	withSessionDesktopMocks(t,
		func() error { return wantErr },
		func() (uintptr, error) { openCalled = true; return 1, nil },
		func(uintptr) error { return nil },
		func(uintptr) {},
	)

	err := withActiveDesktop(func() error { fnCalled = true; return nil })

	if !errors.Is(err, wantErr) {
		t.Fatalf("esperava erro propagado de ensureInteractiveWindowStation, veio %v", err)
	}
	if openCalled {
		t.Fatal("OpenInputDesktop não deveria ter sido chamado -- ensure falhou antes")
	}
	if fnCalled {
		t.Fatal("fn não deveria ter rodado -- ensure falhou antes")
	}
}

func TestWithActiveDesktopOpenInputDesktopFailsNeverClosesOrRunsFn(t *testing.T) {
	wantErr := errors.New("OpenInputDesktop falhou: acesso negado")
	var closeCalled, fnCalled bool

	withSessionDesktopMocks(t,
		func() error { return nil },
		func() (uintptr, error) { return 0, wantErr },
		func(uintptr) error { return nil },
		func(uintptr) { closeCalled = true },
	)

	err := withActiveDesktop(func() error { fnCalled = true; return nil })

	if err == nil {
		t.Fatal("esperava erro, veio nil")
	}
	if closeCalled {
		t.Fatal("CloseDesktop não deveria ter sido chamado -- nunca houve handle pra fechar")
	}
	if fnCalled {
		t.Fatal("fn não deveria ter rodado")
	}
}

// Achado real a evitar: se SetThreadDesktop falhar, o handle do
// OpenInputDesktop AINDA assim precisa ser fechado (defer já registrado) --
// senão vaza um handle de desktop a cada falha, silenciosamente, numa
// feature que vai rodar repetidamente (1 captura a cada 100ms numa sessão
// ao vivo).
func TestWithActiveDesktopSetThreadDesktopFailsStillClosesHandle(t *testing.T) {
	const fakeHandle uintptr = 0x1234
	wantErr := errors.New("SetThreadDesktop falhou")
	var closedWith uintptr
	var fnCalled bool

	withSessionDesktopMocks(t,
		func() error { return nil },
		func() (uintptr, error) { return fakeHandle, nil },
		func(uintptr) error { return wantErr },
		func(h uintptr) { closedWith = h },
	)

	err := withActiveDesktop(func() error { fnCalled = true; return nil })

	if !errors.Is(err, wantErr) {
		t.Fatalf("esperava erro propagado de SetThreadDesktop, veio %v", err)
	}
	if fnCalled {
		t.Fatal("fn não deveria ter rodado -- SetThreadDesktop falhou antes")
	}
	if closedWith != fakeHandle {
		t.Fatalf("CloseDesktop deveria ter rodado com %v mesmo com SetThreadDesktop falhando, veio %v", fakeHandle, closedWith)
	}
}

func TestWithActiveDesktopClosesHandleEvenWhenFnFails(t *testing.T) {
	const fakeHandle uintptr = 0x5678
	wantErr := errors.New("falha dentro de fn")
	var closedWith uintptr

	withSessionDesktopMocks(t,
		func() error { return nil },
		func() (uintptr, error) { return fakeHandle, nil },
		func(uintptr) error { return nil },
		func(h uintptr) { closedWith = h },
	)

	err := withActiveDesktop(func() error { return wantErr })

	if !errors.Is(err, wantErr) {
		t.Fatalf("esperava erro de fn propagado, veio %v", err)
	}
	if closedWith != fakeHandle {
		t.Fatalf("CloseDesktop deveria ter rodado mesmo com fn falhando, veio %v (esperava %v)", closedWith, fakeHandle)
	}
}

// withActiveDesktopIfSessionZero: achado de design -- fora do modo
// session-zero (companion normal, 100% dos casos de hoje), este wrapper
// tem que ser NO-OP de verdade, nunca tocar em withActiveDesktopFn. Testa
// substituindo withActiveDesktopFn por algo que falharia o teste se
// chamado. isSessionZeroFn (não mais um flag global -- achado 🟠 do
// code-reviewer, ver comentário de liveSessionHandle.sessionZero em
// livesession_windows.go) é mockado aqui pra isolar a lógica de
// withActiveDesktopIfSessionZero do mapa liveSessions de verdade.
func TestWithActiveDesktopIfSessionZeroFalseRunsFnDirectly(t *testing.T) {
	origFn := withActiveDesktopFn
	t.Cleanup(func() { withActiveDesktopFn = origFn })
	withActiveDesktopFn = func(func() error) error {
		t.Fatal("withActiveDesktopFn não deveria ter sido chamado -- isSessionZeroFn devolve false")
		return nil
	}
	origIsSessionZero := isSessionZeroFn
	t.Cleanup(func() { isSessionZeroFn = origIsSessionZero })
	isSessionZeroFn = func(string) bool { return false }

	var fnRan bool
	err := withActiveDesktopIfSessionZero("s1", func() error { fnRan = true; return nil })

	if err != nil {
		t.Fatalf("esperava nil, veio %v", err)
	}
	if !fnRan {
		t.Fatal("fn deveria ter rodado direto")
	}
}

func TestWithActiveDesktopIfSessionZeroTrueUsesWithActiveDesktop(t *testing.T) {
	origFn := withActiveDesktopFn
	t.Cleanup(func() { withActiveDesktopFn = origFn })
	var wrapperCalled bool
	withActiveDesktopFn = func(fn func() error) error {
		wrapperCalled = true
		return fn()
	}
	origIsSessionZero := isSessionZeroFn
	t.Cleanup(func() { isSessionZeroFn = origIsSessionZero })
	var gotSessionID string
	isSessionZeroFn = func(sessionID string) bool { gotSessionID = sessionID; return true }

	var fnRan bool
	err := withActiveDesktopIfSessionZero("s1", func() error { fnRan = true; return nil })

	if err != nil {
		t.Fatalf("esperava nil, veio %v", err)
	}
	if gotSessionID != "s1" {
		t.Errorf("isSessionZeroFn recebeu sessionID=%q, want s1", gotSessionID)
	}
	if !wrapperCalled {
		t.Fatal("withActiveDesktopFn deveria ter sido chamado -- isSessionZeroFn devolve true")
	}
	if !fnRan {
		t.Fatal("fn deveria ter rodado (via o wrapper)")
	}
}

// TestWithActiveDesktopIfSessionZeroDoesNotCollideBetweenSessions: achado
// 🟠 do code-reviewer corrigido -- 2 sessionIDs diferentes rodando
// concorrentemente (ex: overlap breve entre o stop de uma sessão antiga e
// o start de uma nova durante um reconnect) não podem mais colidir, já
// que a decisão agora é por sessionID (isSessionZeroFn), não um bool de
// pacote compartilhado.
func TestWithActiveDesktopIfSessionZeroDoesNotCollideBetweenSessions(t *testing.T) {
	origIsSessionZero := isSessionZeroFn
	t.Cleanup(func() { isSessionZeroFn = origIsSessionZero })
	isSessionZeroFn = func(sessionID string) bool { return sessionID == "session-zero-id" }

	origFn := withActiveDesktopFn
	t.Cleanup(func() { withActiveDesktopFn = origFn })
	withActiveDesktopFn = func(fn func() error) error { return fn() }

	var companionRanDirect, sessionZeroRanWrapped bool
	err1 := withActiveDesktopIfSessionZero("companion-id", func() error { companionRanDirect = true; return nil })
	err2 := withActiveDesktopIfSessionZero("session-zero-id", func() error { sessionZeroRanWrapped = true; return nil })

	if err1 != nil || err2 != nil {
		t.Fatalf("esperava nil nos dois, veio %v / %v", err1, err2)
	}
	if !companionRanDirect || !sessionZeroRanWrapped {
		t.Fatal("as duas sessões deveriam ter rodado fn, cada uma pelo caminho certo pro seu próprio sessionID")
	}
}

func TestActiveDesktopNamePropagatesEnsureWindowStationError(t *testing.T) {
	wantErr := errors.New("sem permissao")
	withSessionDesktopMocks(t,
		func() error { return wantErr },
		func() (uintptr, error) { return 1, nil },
		func(uintptr) error { return nil },
		func(uintptr) {},
	)

	_, err := activeDesktopName()

	if !errors.Is(err, wantErr) {
		t.Fatalf("esperava erro propagado, veio %v", err)
	}
}

func TestActiveDesktopNamePropagatesOpenInputDesktopError(t *testing.T) {
	wantErr := errors.New("OpenInputDesktop falhou")
	withSessionDesktopMocks(t,
		func() error { return nil },
		func() (uintptr, error) { return 0, wantErr },
		func(uintptr) error { return nil },
		func(uintptr) {},
	)

	_, err := activeDesktopName()

	if err == nil {
		t.Fatal("esperava erro, veio nil")
	}
}

// withWindowStationMocks mocka as 3 chamadas Win32 de
// openAndSetInteractiveWindowStation -- usado só pelos testes abaixo, que
// chamam ensureInteractiveWindowStation DIRETO (não a Fn), pra exercitar o
// sync.Once de verdade.
func withWindowStationMocks(t *testing.T, open func() (uintptr, error), setStation func(uintptr) error, closeStation func(uintptr)) {
	t.Helper()
	origOpen, origSet, origClose := openWindowStationFn, setProcessWindowStationFn, closeWindowStationFn
	openWindowStationFn, setProcessWindowStationFn, closeWindowStationFn = open, setStation, closeStation
	t.Cleanup(func() {
		openWindowStationFn, setProcessWindowStationFn, closeWindowStationFn = origOpen, origSet, origClose
	})
}

// TestEnsureInteractiveWindowStationRunsOnlyOnce: achado 🟡 do
// code-reviewer -- confirma o comportamento real que o sync.Once existe
// pra garantir (achado 🟠 ALTO da rodada anterior: o guard por atomic.Bool
// não serializava de verdade). 2 chamadas -- a 2ª não deveria refazer
// NENHUM dos 2 syscalls.
func TestEnsureInteractiveWindowStationRunsOnlyOnce(t *testing.T) {
	resetInteractiveWindowStationOnce(t)
	var openCalls, setCalls int
	withWindowStationMocks(t,
		func() (uintptr, error) { openCalls++; return 0xAAAA, nil },
		func(uintptr) error { setCalls++; return nil },
		func(uintptr) {},
	)

	if err := ensureInteractiveWindowStation(); err != nil {
		t.Fatalf("1ª chamada: esperava nil, veio %v", err)
	}
	if err := ensureInteractiveWindowStation(); err != nil {
		t.Fatalf("2ª chamada: esperava nil, veio %v", err)
	}

	if openCalls != 1 || setCalls != 1 {
		t.Errorf("openWindowStationFn chamado %d vez(es), setProcessWindowStationFn %d vez(es) -- queria exatamente 1 de cada (sync.Once)", openCalls, setCalls)
	}
}

// TestEnsureInteractiveWindowStationCachesFailure: uma falha na 1ª chamada
// fica fixa pra sempre (sem retry, decisão deliberada -- ver comentário de
// interactiveWindowStationOnce) -- a 2ª chamada devolve o MESMO erro sem
// tentar os syscalls de novo.
func TestEnsureInteractiveWindowStationCachesFailure(t *testing.T) {
	resetInteractiveWindowStationOnce(t)
	wantErr := errors.New("acesso negado a WinSta0")
	var openCalls int
	withWindowStationMocks(t,
		func() (uintptr, error) { openCalls++; return 0, wantErr },
		func(uintptr) error { return nil },
		func(uintptr) {},
	)

	err1 := ensureInteractiveWindowStation()
	err2 := ensureInteractiveWindowStation()

	if !errors.Is(err1, wantErr) || !errors.Is(err2, wantErr) {
		t.Fatalf("esperava o mesmo erro nas 2 chamadas, veio %v / %v", err1, err2)
	}
	if openCalls != 1 {
		t.Errorf("openWindowStationFn chamado %d vez(es), queria exatamente 1 (sync.Once cacheia a falha, sem retry)", openCalls)
	}
}

// TestEnsureInteractiveWindowStationClosesHandleWhenSetProcessFails:
// confirma o fix do achado 🔴 CRÍTICO da rodada anterior (handle de
// OpenWindowStationW vazando quando SetProcessWindowStation falhava).
func TestEnsureInteractiveWindowStationClosesHandleWhenSetProcessFails(t *testing.T) {
	resetInteractiveWindowStationOnce(t)
	const fakeHandle uintptr = 0xBEEF
	var closedWith uintptr
	withWindowStationMocks(t,
		func() (uintptr, error) { return fakeHandle, nil },
		func(uintptr) error { return errors.New("SetProcessWindowStation falhou") },
		func(h uintptr) { closedWith = h },
	)

	if err := ensureInteractiveWindowStation(); err == nil {
		t.Fatal("esperava erro, veio nil")
	}
	if closedWith != fakeHandle {
		t.Errorf("closeWindowStationFn recebeu %v, esperava %v (handle vazando)", closedWith, fakeHandle)
	}
}
