package main

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ── XML parsing structures ────────────────────────────────────────────────────

type nfceXMLRoot struct {
	NFe     nfceXMLNFe  `xml:"NFe"`
	ProtNFe nfceXMLProt `xml:"protNFe"`
}

type nfceXMLNFe struct {
	InfNFe nfceXMLInfNFe `xml:"infNFe"`
}

type nfceXMLInfNFe struct {
	Ide        nfceXMLIde   `xml:"ide"`
	Emit       nfceXMLEmit  `xml:"emit"`
	Dest       nfceXMLDest  `xml:"dest"`
	Det        []nfceXMLDet `xml:"det"`
	Total      nfceXMLTotal `xml:"total"`
	Pag        nfceXMLPag   `xml:"pag"`
	InfNFeSupl nfceXMLSupl  `xml:"infNFeSupl"`
}

type nfceXMLIde struct {
	NNF   int    `xml:"nNF"`
	CSer  string `xml:"cSer"`
	DhEmi string `xml:"dhEmi"`
}

type nfceXMLEmit struct {
	CNPJ      string       `xml:"CNPJ"`
	XNome     string       `xml:"xNome"`
	XFant     string       `xml:"xFant"`
	EnderEmit nfceXMLEnder `xml:"enderEmit"`
	IE        string       `xml:"IE"`
}

type nfceXMLEnder struct {
	XLgr    string `xml:"xLgr"`
	Nro     string `xml:"nro"`
	XBairro string `xml:"xBairro"`
	XMun    string `xml:"xMun"`
	UF      string `xml:"UF"`
	CEP     string `xml:"CEP"`
}

type nfceXMLDest struct {
	CPF   string `xml:"CPF"`
	CNPJ  string `xml:"CNPJ"`
	XNome string `xml:"xNome"`
}

type nfceXMLDet struct {
	NItem string      `xml:"nItem,attr"`
	Prod  nfceXMLProd `xml:"prod"`
}

type nfceXMLProd struct {
	CProd  string  `xml:"cProd"`
	XProd  string  `xml:"xProd"`
	UCom   string  `xml:"uCom"`
	QCom   float64 `xml:"qCom"`
	VUnCom float64 `xml:"vUnCom"`
	VProd  float64 `xml:"vProd"`
}

type nfceXMLTotal struct {
	ICMSTot nfceXMLICMSTot `xml:"ICMSTot"`
}

type nfceXMLICMSTot struct {
	VBC    float64 `xml:"vBC"`
	VICMS  float64 `xml:"vICMS"`
	VProd  float64 `xml:"vProd"`
	VFrete float64 `xml:"vFrete"`
	VDesc  float64 `xml:"vDesc"`
	VNF    float64 `xml:"vNF"`
}

type nfceXMLPag struct {
	DetPag []nfceXMLDetPag `xml:"detPag"`
}

type nfceXMLDetPag struct {
	TPag string  `xml:"tPag"`
	VPag float64 `xml:"vPag"`
}

type nfceXMLSupl struct {
	QrCode   string `xml:"qrCode"`
	UrlChave string `xml:"urlChave"`
}

type nfceXMLProt struct {
	InfProt nfceXMLInfProt `xml:"infProt"`
}

type nfceXMLInfProt struct {
	ChNFe string `xml:"chNFe"`
}

// ── Output structures (sent to server) ───────────────────────────────────────

// NFCeEmitPayload carries emitter info for DANFE generation.
type NFCeEmitPayload struct {
	CNPJ    string `json:"cnpj"`
	XNome   string `json:"xNome"`
	XFant   string `json:"xFant"`
	XLgr    string `json:"xLgr"`
	Nro     string `json:"nro"`
	XBairro string `json:"xBairro"`
	XMun    string `json:"xMun"`
	UF      string `json:"UF"`
	CEP     string `json:"CEP"`
	IE      string `json:"ie"`
}

// NFCeDestPayload carries optional recipient info.
type NFCeDestPayload struct {
	CPF   string `json:"cpf,omitempty"`
	CNPJ  string `json:"cnpj,omitempty"`
	XNome string `json:"xNome,omitempty"`
}

// NFCeProdPayload is a single product line.
type NFCeProdPayload struct {
	NItem  string  `json:"nItem"`
	CProd  string  `json:"cProd"`
	XProd  string  `json:"xProd"`
	UCom   string  `json:"uCom"`
	QCom   float64 `json:"qCom"`
	VUnCom float64 `json:"vUnCom"`
	VProd  float64 `json:"vProd"`
}

// NFCeTotalsPayload carries invoice totals.
type NFCeTotalsPayload struct {
	VBC    float64 `json:"vBC"`
	VICMS  float64 `json:"vICMS"`
	VProd  float64 `json:"vProd"`
	VFrete float64 `json:"vFrete"`
	VDesc  float64 `json:"vDesc"`
	VNF    float64 `json:"vNF"`
}

// NFCePayPayload describes one payment method.
type NFCePayPayload struct {
	TPag string  `json:"tPag"`
	VPag float64 `json:"vPag"`
}

// NFCeDanfe carries all data needed for PDF/email generation on the server.
type NFCeDanfe struct {
	Chave    string            `json:"chave"`
	NNF      int               `json:"nNF"`
	Series   string            `json:"series"`
	DhEmi    string            `json:"dhEmi"`
	VNF      float64           `json:"vNF"`
	Emit     NFCeEmitPayload   `json:"emit"`
	Dest     *NFCeDestPayload  `json:"dest,omitempty"`
	Products []NFCeProdPayload `json:"products"`
	Totals   NFCeTotalsPayload `json:"totals"`
	Payment  []NFCePayPayload  `json:"payment"`
	QrCode   string            `json:"qrCode"`
	UrlChave string            `json:"urlChave"`
}

// NFCeRecord is one NF-Ce record returned by the agent.
type NFCeRecord struct {
	Chave     string    `json:"chave"`
	NNF       int       `json:"n_nf"`
	DhEmi     string    `json:"dh_emi"`
	VNF       float64   `json:"v_nf"`
	DayFolder string    `json:"day_folder"`
	Danfe     NFCeDanfe `json:"danfe"`
}

// NFCeIndexDayResult is the command result for aloha-index-nfce-day.
type NFCeIndexDayResult struct {
	Month      string       `json:"month"`
	Day        string       `json:"day"`
	Records    []NFCeRecord `json:"records"`
	Skipped    int          `json:"skipped"`
	ErrorCount int          `json:"error_count"`
}

// ── Month listing ─────────────────────────────────────────────────────────────

// NFCeMonthInfo describes one month folder and its available day sub-folders.
type NFCeMonthInfo struct {
	Year  string   `json:"year"`  // e.g. "2026"
	Month string   `json:"month"` // e.g. "06"
	Days  []string `json:"days"`  // e.g. ["01","02",...]
}

// NFCeListMonthsResult is the response for the aloha-list-nfce-months command.
type NFCeListMonthsResult struct {
	Months []NFCeMonthInfo `json:"months"`
}

// listNFCeMonths enumerates year/month/day subdirectories in alohaNFCePath.
// Estrutura real: XML\{YYYY}\{MM}\{DD}\NFCe\
func listNFCeMonths() NFCeListMonthsResult {
	result := NFCeListMonthsResult{Months: []NFCeMonthInfo{}}
	yearEntries, err := os.ReadDir(alohaNFCePath)
	if err != nil {
		return result
	}
	for _, yearEntry := range yearEntries {
		if !yearEntry.IsDir() || len(yearEntry.Name()) != 4 {
			continue
		}
		monthEntries, err := os.ReadDir(filepath.Join(alohaNFCePath, yearEntry.Name()))
		if err != nil {
			continue
		}
		for _, monthEntry := range monthEntries {
			if !monthEntry.IsDir() || len(monthEntry.Name()) != 2 {
				continue
			}
			info := NFCeMonthInfo{Year: yearEntry.Name(), Month: monthEntry.Name(), Days: []string{}}
			dayEntries, err := os.ReadDir(filepath.Join(alohaNFCePath, yearEntry.Name(), monthEntry.Name()))
			if err == nil {
				for _, d := range dayEntries {
					if d.IsDir() && len(d.Name()) == 2 {
						info.Days = append(info.Days, d.Name())
					}
				}
			}
			result.Months = append(result.Months, info)
		}
	}
	return result
}

// indexNFCeDay scans C:\Bootdrv\AlohaFiscal\ServerData\XML\{YYYY}\{MM}\{DD}\NFCe\ for XMLs.
func indexNFCeDay(month, day string) NFCeIndexDayResult {
	result := NFCeIndexDayResult{
		Month:   month,
		Day:     day,
		Records: []NFCeRecord{},
	}

	yearPart := ""
	monthPart := ""
	if len(month) >= 7 {
		yearPart = month[0:4]  // "2026" from "2026-06"
		monthPart = month[5:7] // "06" from "2026-06"
	}
	dayPath := filepath.Join(alohaNFCePath, yearPart, monthPart, day, "NFCe")
	entries, err := os.ReadDir(dayPath)
	if err != nil {
		// Day folder may not exist — treat as empty, not an error
		return result
	}

	for _, entry := range entries {
		if entry.IsDir() || !strings.EqualFold(filepath.Ext(entry.Name()), ".xml") {
			continue
		}
		rec, err := parseNFCeFile(filepath.Join(dayPath, entry.Name()), day)
		if err != nil {
			result.ErrorCount++
			continue
		}
		if rec.Chave == "" {
			result.Skipped++
			continue
		}
		result.Records = append(result.Records, rec)
	}
	return result
}

// parseNFCeFile parses a single NF-Ce XML file into NFCeRecord.
func parseNFCeFile(xmlPath, dayFolder string) (NFCeRecord, error) {
	data, err := os.ReadFile(xmlPath)
	if err != nil {
		return NFCeRecord{}, fmt.Errorf("read %s: %w", xmlPath, err)
	}

	// Strip default namespace declaration so struct tags match by local name only
	cleaned := bytes.ReplaceAll(data,
		[]byte(` xmlns="http://www.portalfiscal.inf.br/nfe"`), []byte(""))

	var root nfceXMLRoot
	if err := xml.Unmarshal(cleaned, &root); err != nil {
		return NFCeRecord{}, fmt.Errorf("parse %s: %w", xmlPath, err)
	}

	inf := root.NFe.InfNFe
	chave := root.ProtNFe.InfProt.ChNFe

	danfe := NFCeDanfe{
		Chave:    chave,
		NNF:      inf.Ide.NNF,
		Series:   inf.Ide.CSer,
		DhEmi:    inf.Ide.DhEmi,
		VNF:      inf.Total.ICMSTot.VNF,
		QrCode:   inf.InfNFeSupl.QrCode,
		UrlChave: inf.InfNFeSupl.UrlChave,
		Emit: NFCeEmitPayload{
			CNPJ:    inf.Emit.CNPJ,
			XNome:   inf.Emit.XNome,
			XFant:   inf.Emit.XFant,
			XLgr:    inf.Emit.EnderEmit.XLgr,
			Nro:     inf.Emit.EnderEmit.Nro,
			XBairro: inf.Emit.EnderEmit.XBairro,
			XMun:    inf.Emit.EnderEmit.XMun,
			UF:      inf.Emit.EnderEmit.UF,
			CEP:     inf.Emit.EnderEmit.CEP,
			IE:      inf.Emit.IE,
		},
		Totals: NFCeTotalsPayload{
			VBC:    inf.Total.ICMSTot.VBC,
			VICMS:  inf.Total.ICMSTot.VICMS,
			VProd:  inf.Total.ICMSTot.VProd,
			VFrete: inf.Total.ICMSTot.VFrete,
			VDesc:  inf.Total.ICMSTot.VDesc,
			VNF:    inf.Total.ICMSTot.VNF,
		},
	}

	if inf.Dest.CPF != "" || inf.Dest.CNPJ != "" || inf.Dest.XNome != "" {
		danfe.Dest = &NFCeDestPayload{
			CPF:   inf.Dest.CPF,
			CNPJ:  inf.Dest.CNPJ,
			XNome: inf.Dest.XNome,
		}
	}

	danfe.Products = make([]NFCeProdPayload, 0, len(inf.Det))
	for _, det := range inf.Det {
		danfe.Products = append(danfe.Products, NFCeProdPayload{
			NItem:  det.NItem,
			CProd:  det.Prod.CProd,
			XProd:  det.Prod.XProd,
			UCom:   det.Prod.UCom,
			QCom:   det.Prod.QCom,
			VUnCom: det.Prod.VUnCom,
			VProd:  det.Prod.VProd,
		})
	}

	danfe.Payment = make([]NFCePayPayload, 0, len(inf.Pag.DetPag))
	for _, p := range inf.Pag.DetPag {
		danfe.Payment = append(danfe.Payment, NFCePayPayload{
			TPag: p.TPag,
			VPag: p.VPag,
		})
	}

	return NFCeRecord{
		Chave:     chave,
		NNF:       inf.Ide.NNF,
		DhEmi:     inf.Ide.DhEmi,
		VNF:       inf.Total.ICMSTot.VNF,
		DayFolder: dayFolder,
		Danfe:     danfe,
	}, nil
}

// productsText returns a space-separated list of product names for full-text search.
func productsText(products []NFCeProdPayload) string {
	names := make([]string, 0, len(products))
	for _, p := range products {
		if p.XProd != "" {
			names = append(names, p.XProd)
		}
	}
	return strings.Join(names, " | ")
}

// nfceRecordToJSON serialises an NFCeIndexDayResult to JSON string.
func nfceRecordToJSON(r NFCeIndexDayResult) (string, error) {
	data, err := json.Marshal(r)
	if err != nil {
		return "", err
	}
	return string(data), nil
}
