package main

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"os/exec"
	"sort"
	"strings"
	"time"
)

// WinEvent represents a single Windows Event Log entry.
type WinEvent struct {
	EventTime   string `json:"eventTime"`
	EventID     int    `json:"eventId"`
	Source      string `json:"source"`
	Level       string `json:"level"`
	Translation string `json:"translation"`
	RawMessage  string `json:"rawMessage"`
}

// EventsPayload is the JSON body sent to POST /api/win-events.
type EventsPayload struct {
	MachineID string     `json:"machineId"`
	Token     string     `json:"token"`
	Events    []WinEvent `json:"events"`
}

// eventTranslations maps Windows Event ID to PT-BR description.
var eventTranslations = map[int]string{
	// Kernel-General (IDs modernos de boot no Windows 11)
	12:    "Sistema operacional iniciado (boot normal)",
	13:    "Sistema operacional desligado normalmente",
	// Kernel-Power
	41:    "Reinicialização inesperada — possível queda de energia ou travamento",
	6008:  "Desligamento inesperado anterior detectado pelo sistema",
	1074:  "Desligamento ou reinício programado registrado",
	1076:  "Motivo do último desligamento registrado pelo operador",
	// EventLog legacy (Windows Server / Windows antigo)
	6005:  "Sistema iniciado normalmente",
	6006:  "Desligamento limpo do sistema",
	6009:  "Versão do Windows registrada na inicialização",
	6013:  "Tempo de atividade do sistema registrado",
	// Windows Update
	19:    "Windows Update: atualização instalada com sucesso",
	20:    "Windows Update: falha na instalação de atualização",
	43:    "Windows Update: instalação de atualizações iniciada",
	44:    "Windows Update: download de atualizações iniciado",
	// Serviços
	7034:  "Serviço do sistema encerrou inesperadamente",
	7036:  "Status de serviço do sistema alterado",
	7040:  "Tipo de inicialização de serviço alterado",
	7045:  "Novo serviço instalado no sistema",
	// Disco
	7:     "Erro de leitura ou escrita detectado no disco",
	51:    "Aviso de erro em dispositivo de armazenamento",
	129:   "Timeout de reset no controlador de armazenamento",
	// Rede
	10000: "Adaptador de rede conectado",
	10001: "Adaptador de rede desconectado",
	// Energia / suspensão
	42:    "Sistema entrando em modo de suspensão",
	107:   "Sistema saindo de modo de suspensão",
	109:   "Kernel iniciou sequência de energia",
	// Segurança
	4624:  "Login bem-sucedido no sistema",
	4625:  "Tentativa de login falhou",
	4800:  "Estação de trabalho bloqueada",
	4801:  "Estação de trabalho desbloqueada",
	// BSOD
	1001:  "Falha crítica do sistema (BSOD) detectada",
}

// monitoredIDs lista os Event IDs que o agente coleta.
var monitoredIDs = []int{
	12, 13, 41, 6008, 1074, 1076, 6005, 6006, 6009, 6013,
	19, 20, 43, 44, 7034, 7036, 7040, 7045, 7, 51, 129,
	10000, 10001, 42, 107, 109, 4624, 4625, 4800, 4801, 1001,
}

func translateEvent(id int, source string) string {
	if t, ok := eventTranslations[id]; ok {
		return t
	}
	return fmt.Sprintf("Evento do sistema — ID %d, Fonte: %s", id, source)
}

func wevtLevelToString(level int) string {
	switch level {
	case 1:
		return "critical"
	case 2:
		return "error"
	case 3:
		return "warning"
	default:
		return "info"
	}
}

// wevtEvent é o struct para deserializar um <Event> do output XML do wevtutil.
type wevtEvent struct {
	System struct {
		Provider struct {
			Name string `xml:"Name,attr"`
		} `xml:"Provider"`
		EventID     int `xml:"EventID"`
		Level       int `xml:"Level"`
		TimeCreated struct {
			SystemTime string `xml:"SystemTime,attr"`
		} `xml:"TimeCreated"`
	} `xml:"System"`
	EventData struct {
		Data []struct {
			Name  string `xml:"Name,attr"`
			Value string `xml:",chardata"`
		} `xml:"Data"`
	} `xml:"EventData"`
}

// collectWindowsEvents consulta o Event Log via wevtutil.exe (sem PowerShell).
// wevtutil é uma ferramenta nativa do Windows que funciona corretamente
// no contexto SYSTEM do Service Control Manager.
func collectWindowsEvents(since time.Time) ([]WinEvent, error) {
	// XPath só com IDs (sem filtro de tempo — o filtro temporal é aplicado em Go após o parse,
	// pois o predicado TimeCreated no XPath do wevtutil pode falhar silenciosamente).
	idParts := make([]string, len(monitoredIDs))
	for i, id := range monitoredIDs {
		idParts[i] = fmt.Sprintf("EventID=%d", id)
	}
	xpath := fmt.Sprintf("*[System[(%s)]]", strings.Join(idParts, " or "))

	var allEvents []WinEvent
	for _, logName := range []string{"System", "Application"} {
		events, err := queryWevtutil(logName, xpath, since)
		if err != nil {
			logWarn(fmt.Sprintf("wevtutil %s: %v", logName, err))
			continue
		}
		logInfo(fmt.Sprintf("wevtutil %s: %d eventos encontrados", logName, len(events)))
		allEvents = append(allEvents, events...)
	}

	// Ordena cronologicamente
	sort.Slice(allEvents, func(i, j int) bool {
		return allEvents[i].EventTime < allEvents[j].EventTime
	})

	// Limita a 200 eventos
	if len(allEvents) > 200 {
		allEvents = allEvents[len(allEvents)-200:]
	}

	return allEvents, nil
}

// queryWevtutil executa wevtutil.exe para consultar eventos de um log específico.
// O filtro temporal é aplicado em Go após o parse do XML.
func queryWevtutil(logName, xpath string, since time.Time) ([]WinEvent, error) {
	cmd := exec.Command("wevtutil.exe", "qe", logName,
		"/q:"+xpath,
		"/f:xml",
		"/c:200")

	var out, errBuf bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errBuf

	if err := cmd.Run(); err != nil {
		stderr := strings.TrimSpace(errBuf.String())
		logWarn(fmt.Sprintf("wevtutil %s erro: %v | stderr: %s | stdout_bytes: %d", logName, err, stderr, out.Len()))
		if out.Len() == 0 {
			return nil, nil
		}
		return nil, fmt.Errorf("%w (stderr: %s)", err, stderr)
	}

	if out.Len() == 0 {
		return nil, nil
	}

	return parseWevtutilXML(out.Bytes(), since)
}

// parseWevtutilXML deserializa o XML concatenado do wevtutil em structs WinEvent,
// filtrando eventos anteriores a since.
func parseWevtutilXML(data []byte, since time.Time) ([]WinEvent, error) {
	// Remove a declaração de namespace para simplificar o parsing
	data = bytes.ReplaceAll(data,
		[]byte("xmlns='http://schemas.microsoft.com/win/2004/08/events/event'"),
		[]byte(""))
	data = bytes.ReplaceAll(data,
		[]byte(`xmlns="http://schemas.microsoft.com/win/2004/08/events/event"`),
		[]byte(""))

	// wevtutil outputs <Event> elements concatenados sem root — envolve em <root>
	wrapped := append([]byte("<root>"), append(data, []byte("</root>")...)...)

	var root struct {
		XMLName xml.Name    `xml:"root"`
		Events  []wevtEvent `xml:"Event"`
	}
	if err := xml.Unmarshal(wrapped, &root); err != nil {
		return nil, fmt.Errorf("parse wevtutil xml: %w", err)
	}

	events := make([]WinEvent, 0, len(root.Events))
	for _, e := range root.Events {
		// Monta rawMessage com os pares nome=valor do EventData
		rawParts := make([]string, 0, len(e.EventData.Data))
		for _, d := range e.EventData.Data {
			if d.Value != "" {
				if d.Name != "" {
					rawParts = append(rawParts, d.Name+": "+d.Value)
				} else {
					rawParts = append(rawParts, d.Value)
				}
			}
		}

		events = append(events, WinEvent{
			EventTime:   e.System.TimeCreated.SystemTime,
			EventID:     e.System.EventID,
			Source:      e.System.Provider.Name,
			Level:       wevtLevelToString(e.System.Level),
			Translation: translateEvent(e.System.EventID, e.System.Provider.Name),
			RawMessage:  strings.Join(rawParts, " | "),
		})
	}

	return events, nil
}

// sendEvents envia os eventos coletados ao servidor.
func (a *Agent) sendEvents(events []WinEvent) error {
	if len(events) == 0 {
		return nil
	}
	payload := EventsPayload{
		MachineID: a.cfg.MachineID,
		Token:     a.cfg.Token,
		Events:    events,
	}
	resp, err := a.post("/api/win-events", payload)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return nil
}
