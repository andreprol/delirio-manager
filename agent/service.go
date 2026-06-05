package main

import (
	"golang.org/x/sys/windows/svc"
)

// windowsService implementa a interface svc.Handler do Windows SCM.
type windowsService struct{}

func (ws *windowsService) Execute(args []string, req <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}

	a := newAgent()
	if err := a.start(); err != nil {
		logError("Falha ao iniciar agente: " + err.Error())
		return false, 1
	}

	status <- svc.Status{
		State:   svc.Running,
		Accepts: svc.AcceptStop | svc.AcceptShutdown,
	}

	logInfo("DelirioAgent v" + Version + " iniciado.")

	for c := range req {
		switch c.Cmd {
		case svc.Stop, svc.Shutdown:
			status <- svc.Status{State: svc.StopPending}
			a.stop()
			logInfo("DelirioAgent parado.")
			return false, 0
		case svc.Interrogate:
			status <- c.CurrentStatus
		}
	}

	return false, 0
}
