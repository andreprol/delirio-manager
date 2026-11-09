package main

import (
	"os"
	"path/filepath"
	"testing"
)

// XML de amostra fiel à estrutura real da NFC-e v4.00 da SEFAZ: infNFeSupl é
// IRMÃO de infNFe (ambos filhos diretos de NFe), nunca aninhado dentro de
// infNFe. Bug real (09/11/2026): o struct Go tinha InfNFeSupl aninhado em
// nfceXMLInfNFe, então QrCode/UrlChave vinham sempre vazios em toda NF-Ce já
// indexada — este fixture reproduz o XML real pra travar a regressão.
const sampleNFCeXML = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe xmlns="http://www.portalfiscal.inf.br/nfe">
    <infNFe Id="NFe33261128301505000105650350001956201581549417" versao="4.00">
      <ide>
        <nNF>195620</nNF>
        <cSer>1</cSer>
        <dhEmi>2026-11-03T17:01:56-03:00</dhEmi>
      </ide>
      <emit>
        <CNPJ>28301505000105</CNPJ>
        <xNome>Loja Teste LTDA</xNome>
        <xFant>Loja Teste</xFant>
        <enderEmit>
          <xLgr>Rua Teste</xLgr>
          <nro>100</nro>
          <xBairro>Centro</xBairro>
          <xMun>Rio de Janeiro</xMun>
          <UF>RJ</UF>
          <CEP>20000000</CEP>
        </enderEmit>
        <IE>12345678</IE>
      </emit>
      <dest>
        <CPF>12345678900</CPF>
        <xNome>Consumidor Teste</xNome>
        <email>cliente@teste.com</email>
      </dest>
      <det nItem="1">
        <prod>
          <cProd>001</cProd>
          <xProd>Produto Teste</xProd>
          <uCom>UN</uCom>
          <qCom>1.0000</qCom>
          <vUnCom>50.00</vUnCom>
          <vProd>50.00</vProd>
        </prod>
      </det>
      <total>
        <ICMSTot>
          <vBC>50.00</vBC>
          <vICMS>0.00</vICMS>
          <vProd>50.00</vProd>
          <vFrete>0.00</vFrete>
          <vDesc>0.00</vDesc>
          <vNF>50.00</vNF>
        </ICMSTot>
      </total>
      <pag>
        <detPag>
          <tPag>17</tPag>
          <vPag>50.00</vPag>
        </detPag>
      </pag>
    </infNFe>
    <infNFeSupl>
      <qrCode>https://www.sefaz.rj.gov.br/nfce/qrcode?p=33261128301505000105650350001956201581549417</qrCode>
      <urlChave>https://www.sefaz.rj.gov.br/nfce/consulta</urlChave>
    </infNFeSupl>
  </NFe>
  <protNFe versao="4.00">
    <infProt>
      <chNFe>33261128301505000105650350001956201581549417</chNFe>
    </infProt>
  </protNFe>
</nfeProc>`

func writeTempXML(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "nota.xml")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("falha ao escrever XML temporário: %v", err)
	}
	return path
}

// ── happy path ───────────────────────────────────────────────────────────────

func TestParseNFCeFile_ExtraiQrCodeEUrlChave(t *testing.T) {
	path := writeTempXML(t, sampleNFCeXML)
	rec, err := parseNFCeFile(path, "03")
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}

	wantQr := "https://www.sefaz.rj.gov.br/nfce/qrcode?p=33261128301505000105650350001956201581549417"
	wantUrl := "https://www.sefaz.rj.gov.br/nfce/consulta"
	if rec.Danfe.QrCode != wantQr {
		t.Errorf("QrCode = %q, want %q", rec.Danfe.QrCode, wantQr)
	}
	if rec.Danfe.UrlChave != wantUrl {
		t.Errorf("UrlChave = %q, want %q", rec.Danfe.UrlChave, wantUrl)
	}
}

func TestParseNFCeFile_ExtraiDemaisCampos(t *testing.T) {
	path := writeTempXML(t, sampleNFCeXML)
	rec, err := parseNFCeFile(path, "03")
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}

	wantChave := "33261128301505000105650350001956201581549417"
	if rec.Chave != wantChave {
		t.Errorf("Chave = %q, want %q", rec.Chave, wantChave)
	}
	if rec.NNF != 195620 {
		t.Errorf("NNF = %d, want 195620", rec.NNF)
	}
	if rec.VNF != 50.00 {
		t.Errorf("VNF = %v, want 50.00", rec.VNF)
	}
	if rec.Danfe.Emit.XNome != "Loja Teste LTDA" {
		t.Errorf("Emit.XNome = %q, want %q", rec.Danfe.Emit.XNome, "Loja Teste LTDA")
	}
	if len(rec.Danfe.Products) != 1 || rec.Danfe.Products[0].XProd != "Produto Teste" {
		t.Errorf("Products incorretos: %+v", rec.Danfe.Products)
	}
}

// ── e-mail do cliente (feature auto-envio, 09/11/2026) ─────────────────────

func TestParseNFCeFile_ExtraiEmailDoDestinatario(t *testing.T) {
	path := writeTempXML(t, sampleNFCeXML)
	rec, err := parseNFCeFile(path, "03")
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if rec.Danfe.Dest == nil {
		t.Fatal("Dest veio nil, esperava preenchido")
	}
	if rec.Danfe.Dest.Email != "cliente@teste.com" {
		t.Errorf("Dest.Email = %q, want %q", rec.Danfe.Dest.Email, "cliente@teste.com")
	}
}

func TestParseNFCeFile_SemEmailNoDest_NaoQuebra(t *testing.T) {
	xmlSemEmail := `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe xmlns="http://www.portalfiscal.inf.br/nfe">
    <infNFe Id="NFe1">
      <ide><nNF>1</nNF><cSer>1</cSer><dhEmi>2026-01-01T10:00:00-03:00</dhEmi></ide>
      <emit><CNPJ>1</CNPJ><xNome>X</xNome></emit>
      <dest><CPF>12345678900</CPF><xNome>Consumidor Teste</xNome></dest>
      <total><ICMSTot><vNF>10.00</vNF></ICMSTot></total>
    </infNFe>
  </NFe>
  <protNFe><infProt><chNFe>chave-teste</chNFe></infProt></protNFe>
</nfeProc>`

	path := writeTempXML(t, xmlSemEmail)
	rec, err := parseNFCeFile(path, "01")
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if rec.Danfe.Dest == nil {
		t.Fatal("Dest veio nil — CPF/xNome deveriam ter populado mesmo sem email")
	}
	if rec.Danfe.Dest.Email != "" {
		t.Errorf("Dest.Email = %q, esperava vazio", rec.Danfe.Dest.Email)
	}
}

// ── regressão explícita do bug ──────────────────────────────────────────────

func TestParseNFCeFile_InfNFeSuplEIrmaoDeInfNFe_NaoFilho(t *testing.T) {
	// XML deliberadamente errado (infNFeSupl aninhado DENTRO de infNFe, como
	// o struct Go tinha até 09/11/2026) — se alguém reintroduzir o bug no
	// struct, os campos abaixo voltam a vir vazios e este teste falha.
	badXML := `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe xmlns="http://www.portalfiscal.inf.br/nfe">
    <infNFe Id="NFe1">
      <ide><nNF>1</nNF><cSer>1</cSer><dhEmi>2026-01-01T10:00:00-03:00</dhEmi></ide>
      <emit><CNPJ>1</CNPJ><xNome>X</xNome></emit>
      <total><ICMSTot><vNF>10.00</vNF></ICMSTot></total>
      <infNFeSupl>
        <qrCode>nao-deveria-ser-lido-daqui</qrCode>
        <urlChave>nao-deveria-ser-lido-daqui</urlChave>
      </infNFeSupl>
    </infNFe>
  </NFe>
  <protNFe><infProt><chNFe>chave-teste</chNFe></infProt></protNFe>
</nfeProc>`

	path := writeTempXML(t, badXML)
	rec, err := parseNFCeFile(path, "01")
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if rec.Danfe.QrCode != "" {
		t.Errorf("QrCode deveria ficar vazio quando infNFeSupl está (erradamente) dentro de infNFe, veio %q", rec.Danfe.QrCode)
	}
	if rec.Chave != "chave-teste" {
		t.Errorf("Chave = %q, want %q (confirma que o resto do XML parseou normalmente)", rec.Chave, "chave-teste")
	}
}

// ── edge cases ───────────────────────────────────────────────────────────────

func TestParseNFCeFile_SemInfNFeSupl_NaoQuebra(t *testing.T) {
	xmlSemSupl := `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe xmlns="http://www.portalfiscal.inf.br/nfe">
    <infNFe Id="NFe1">
      <ide><nNF>1</nNF><cSer>1</cSer><dhEmi>2026-01-01T10:00:00-03:00</dhEmi></ide>
      <emit><CNPJ>1</CNPJ><xNome>X</xNome></emit>
      <total><ICMSTot><vNF>10.00</vNF></ICMSTot></total>
    </infNFe>
  </NFe>
  <protNFe><infProt><chNFe>chave-teste</chNFe></infProt></protNFe>
</nfeProc>`

	path := writeTempXML(t, xmlSemSupl)
	rec, err := parseNFCeFile(path, "01")
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}
	if rec.Danfe.QrCode != "" || rec.Danfe.UrlChave != "" {
		t.Errorf("esperava QrCode/UrlChave vazios sem infNFeSupl, veio QrCode=%q UrlChave=%q", rec.Danfe.QrCode, rec.Danfe.UrlChave)
	}
	if rec.Chave != "chave-teste" {
		t.Errorf("Chave = %q, want %q", rec.Chave, "chave-teste")
	}
}

func TestParseNFCeFile_XMLInvalido_RetornaErro(t *testing.T) {
	path := writeTempXML(t, "isso nao e xml valido <<<")
	_, err := parseNFCeFile(path, "01")
	if err == nil {
		t.Fatal("esperava erro para XML inválido")
	}
}

func TestParseNFCeFile_ArquivoInexistente_RetornaErro(t *testing.T) {
	_, err := parseNFCeFile(filepath.Join(t.TempDir(), "nao-existe.xml"), "01")
	if err == nil {
		t.Fatal("esperava erro para arquivo inexistente")
	}
}
