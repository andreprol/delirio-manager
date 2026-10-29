package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/sys/windows/svc/eventlog"
)

var (
	logMu       sync.Mutex // protege fileLogger/logFile/logFilePath entre goroutines (writeLog x trimLogIfNeeded)
	fileLogger  *log.Logger
	logFile     *os.File // handle explícito para fechar antes de truncar
	evLog       *eventlog.Log
	logFilePath string
)

// openLogFile abre (ou cria) o arquivo de log com os flags dados. Único
// lugar que chama os.OpenFile pra log de arquivo — initLogger e
// trimLogIfNeeded compartilham esta função em vez de duas chamadas
// divergentes, pra nunca mais reintroduzir o bug de 29/10/2026 (erro de
// abertura engolido em silêncio) em só um dos dois caminhos.
func openLogFile(path string, flags int) (*os.File, error) {
	return os.OpenFile(path, flags, 0644)
}

// initLogger recebe o nome do arquivo explicitamente (não var global) —
// serviço e companion são processos separados que rodam concorrentemente
// no mesmo diretório de instalação; compartilhar agent.log faria o
// truncamento de um (trimLogIfNeeded) corromper o handle aberto do outro.
// Chamadores: agent.go#newAgent → initLogger("agent.log"),
// companion.go#runCompanion → initLogger("companion.log").
func initLogger(fileName string) {
	// Aberto antes de qualquer tentativa de arquivo — é o único jeito de
	// reportar uma falha total (Program Files E %TEMP% indisponíveis) em
	// processo sem console (companion roda com CREATE_NO_WINDOW).
	evLog, _ = eventlog.Open(ServiceName)

	primaryPath := filepath.Join(os.TempDir(), fileName) // fallback padrão se nem os.Executable() resolver
	if exe, errExe := os.Executable(); errExe == nil {
		primaryPath = filepath.Join(filepath.Dir(exe), fileName)
	}

	logMu.Lock()
	defer logMu.Unlock()

	logFilePath = primaryPath
	f, errPrimary := openLogFile(primaryPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY)
	if errPrimary != nil {
		// O companion roda sob o token do usuário interativo (não do serviço,
		// que é quem instala em Program Files e normalmente é o único com
		// permissão de escrita lá) — se não conseguir abrir ali, cai pro
		// %TEMP% do próprio usuário, sempre gravável, em vez de perder o log
		// inteiro em silêncio (achado 29/10/2026: companion.log nunca existia
		// em máquinas de loja, zero visibilidade sobre falhas do companion).
		fallback := filepath.Join(os.TempDir(), fileName)
		f2, errFallback := openLogFile(fallback, os.O_APPEND|os.O_CREATE|os.O_WRONLY)
		if errFallback == nil {
			logFilePath = fallback
			f = f2
			if evLog != nil {
				_ = evLog.Warning(2, fmt.Sprintf(
					"%s: Program Files indisponivel (%v) - usando %s", fileName, errPrimary, fallback))
			}
		} else if evLog != nil {
			// Falha dupla: nem Program Files nem %TEMP% — sem isso o processo
			// fica mudo (fileLogger continua nil), mas o Event Log ainda
			// denuncia o motivo em vez de sumir sem rastro.
			_ = evLog.Error(3, fmt.Sprintf(
				"%s: falha ao abrir log em %s (%v) e em %s (%v) - sem log em arquivo",
				fileName, primaryPath, errPrimary, fallback, errFallback))
		}
	}
	if f != nil {
		logFile = f
		fileLogger = log.New(f, "", 0)
	}
}

func logInfo(msg string) {
	entry := fmt.Sprintf("[%s] INFO  %s", timestamp(), msg)
	writeLog(entry)
	if evLog != nil {
		_ = evLog.Info(1, msg)
	}
}

func logWarn(msg string) {
	entry := fmt.Sprintf("[%s] WARN  %s", timestamp(), msg)
	writeLog(entry)
	if evLog != nil {
		_ = evLog.Warning(2, msg)
	}
}

func logError(msg string) {
	entry := fmt.Sprintf("[%s] ERROR %s", timestamp(), msg)
	writeLog(entry)
	if evLog != nil {
		_ = evLog.Error(3, msg)
	}
}

func writeLog(entry string) {
	fmt.Println(entry) // sempre no stdout (visivel em modo -run)

	logMu.Lock()
	defer logMu.Unlock()
	if fileLogger != nil {
		fileLogger.Println(entry)
	}
	trimLogIfNeededLocked()
}

// trimLogIfNeededLocked limita o log a 5MB para nao encher o disco.
// Chamado só por writeLog, que já segura logMu — nome "Locked" deixa essa
// pré-condição explícita (evita alguém chamar de fora sem o lock no futuro).
func trimLogIfNeededLocked() {
	const maxBytes = 5 * 1024 * 1024
	info, err := os.Stat(logFilePath)
	if err != nil || info.Size() < maxBytes {
		return
	}
	// Fecha o handle antigo antes de truncar — obrigatório no Windows:
	// os.Remove falha enquanto o arquivo tiver handles abertos, e O_CREATE
	// sem O_TRUNC apenas reabre o mesmo arquivo gigante, causando loop infinito.
	if logFile != nil {
		logFile.Close()
		logFile = nil
		fileLogger = nil
	}
	// Mesmo path que já serviu (Program Files OU o fallback de %TEMP%,
	// qualquer um que initLogger tenha deixado em logFilePath) — reusa
	// openLogFile em vez de um os.OpenFile próprio, pra uma falha aqui
	// (ex: %TEMP% cheio) não voltar a ser engolida em silêncio só porque é
	// o caminho de rotação em vez do de inicialização.
	f, err := openLogFile(logFilePath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC)
	if err != nil {
		if evLog != nil {
			_ = evLog.Error(3, fmt.Sprintf("reabertura apos rotacao falhou em %s: %v - sem log em arquivo ate o proximo restart", logFilePath, err))
		}
		return
	}
	logFile = f
	fileLogger = log.New(f, "", 0)
	// Escreve direto no arquivo — NÃO via logInfo() para evitar recursão em trimLogIfNeededLocked.
	fmt.Fprintf(f, "[%s] INFO  Log rotacionado (limite de 5MB atingido).\n", timestamp())
}

func timestamp() string {
	return time.Now().Format("2006-01-02 15:04:05")
}
