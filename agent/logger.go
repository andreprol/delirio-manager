package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows/svc/eventlog"
)

var (
	fileLogger  *log.Logger
	evLog       *eventlog.Log
	logFilePath string
)

func initLogger() {
	exe, _ := os.Executable()
	logFilePath = filepath.Join(filepath.Dir(exe), "agent.log")

	f, err := os.OpenFile(logFilePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err == nil {
		fileLogger = log.New(f, "", 0)
	}

	// Windows Event Log (nao falha se nao estiver registrado)
	evLog, _ = eventlog.Open(ServiceName)
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
	if fileLogger != nil {
		fileLogger.Println(entry)
	}
	trimLogIfNeeded()
}

// trimLogIfNeeded limita o log a 5MB para nao encher o disco.
func trimLogIfNeeded() {
	const maxBytes = 5 * 1024 * 1024
	info, err := os.Stat(logFilePath)
	if err != nil || info.Size() < maxBytes {
		return
	}
	// Rotaciona: apaga e recria (simples e suficiente)
	os.Remove(logFilePath)
	if f, err := os.OpenFile(logFilePath, os.O_CREATE|os.O_WRONLY, 0644); err == nil {
		fileLogger = log.New(f, "", 0)
		logInfo("Log rotacionado (limite de 5MB atingido).")
	}
}

func timestamp() string {
	return time.Now().Format("2006-01-02 15:04:05")
}
