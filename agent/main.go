package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/eventlog"
	"golang.org/x/sys/windows/svc/mgr"
)

const (
	ServiceName        = "DelirioAgent"
	ServiceDisplayName = "Delirio Manager Agent"
	ServiceDescription = "Agente de monitoramento Delirio Tropical. Coleta metricas do sistema e executa comandos remotos autorizados pelo servidor central."
	Version            = "1.5.2"
)

func main() {
	install    := flag.Bool("install", false, "Instalar como servico Windows")
	uninstall  := flag.Bool("uninstall", false, "Desinstalar servico Windows")
	run        := flag.Bool("run", false, "Executar em modo console (debug)")
	setServer  := flag.String("server", "", "Definir URL do servidor (ex: https://dt-manager.brazilsouth.cloudapp.azure.com)")
	version    := flag.Bool("version", false, "Exibir versao")
	flag.Parse()

	if *version {
		fmt.Printf("DelirioAgent v%s\n", Version)
		return
	}

	if *setServer != "" {
		cfg, _ := loadConfig()
		cfg.ServerURL = *setServer
		if err := saveConfig(cfg); err != nil {
			log.Fatalf("Erro ao salvar config: %v", err)
		}
		fmt.Printf("Servidor configurado: %s\n", *setServer)
		return
	}

	switch {
	case *install:
		if err := installService(); err != nil {
			log.Fatalf("Erro ao instalar servico: %v", err)
		}
		fmt.Println("Servico DelirioAgent instalado com sucesso.")
		fmt.Println("Para iniciar: sc start DelirioAgent")

	case *uninstall:
		if err := uninstallService(); err != nil {
			log.Fatalf("Erro ao desinstalar servico: %v", err)
		}
		fmt.Println("Servico DelirioAgent removido.")

	case *run:
		fmt.Println("Iniciando DelirioAgent em modo console (Ctrl+C para parar)...")
		a := newAgent()
		if err := a.start(); err != nil {
			log.Fatalf("Erro ao iniciar agente: %v", err)
		}
		select {} // bloqueia forever em modo console

	default:
		// Chamado pelo Service Control Manager do Windows
		if err := svc.Run(ServiceName, &windowsService{}); err != nil {
			log.Fatalf("Erro ao executar como servico: %v", err)
		}
	}
}

func installService() error {
	exePath, err := filepath.Abs(os.Args[0])
	if err != nil {
		return fmt.Errorf("caminho do executavel: %w", err)
	}

	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("conectar ao SCM: %w", err)
	}
	defer m.Disconnect()

	// Remove servico existente se houver
	if s, err := m.OpenService(ServiceName); err == nil {
		s.Control(svc.Stop)
		s.Delete()
		s.Close()
	}

	s, err := m.CreateService(ServiceName, exePath,
		mgr.Config{
			DisplayName:      ServiceDisplayName,
			Description:      ServiceDescription,
			StartType:        mgr.StartAutomatic,
			ServiceStartName: "LocalSystem",
		})
	if err != nil {
		return fmt.Errorf("criar servico: %w", err)
	}
	defer s.Close()

	// Configura recuperacao automatica em caso de falha
	s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 5000},  // 5s
		{Type: mgr.ServiceRestart, Delay: 10000}, // 10s
		{Type: mgr.ServiceRestart, Delay: 30000}, // 30s
	}, 86400) // reset contador apos 1 dia

	// Registra no Event Log do Windows
	eventlog.InstallAsEventCreate(ServiceName, eventlog.Error|eventlog.Warning|eventlog.Info)

	// Inicia o servico imediatamente
	return s.Start()
}

func uninstallService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("conectar ao SCM: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(ServiceName)
	if err != nil {
		return fmt.Errorf("servico nao encontrado: %w", err)
	}
	defer s.Close()

	s.Control(svc.Stop)
	eventlog.Remove(ServiceName)
	return s.Delete()
}
