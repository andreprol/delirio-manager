# VPN Gateway + 2ª VM + Load Balancer — Plano 2/3 (infraestrutura Azure)

> **For agentic workers:** este plano é infraestrutura real (recursos
> Azure pagos, rede de produção, túnel de loja) — execução é **Native**
> (acompanhada, nesta sessão, com confirmação explícita do André antes
> de qualquer comando que crie/altere recurso Azure ou toque a VPN da
> loja Metro), NUNCA subagent-driven sem supervisão. Cada passo de
> criação de recurso para e pede "pode seguir?" antes de rodar.

**Goal:** Eliminar a VM única do Delirio Manager como ponto de falha —
desacoplar a VPN de loja pra um Azure VPN Gateway de verdade, subir uma
2ª VM de app, e colocar as duas atrás de um Load Balancer com health
probe no `/api/healthz` (Plano 1).

**Architecture:** VPN Gateway (`VpnGw1AZ`, zone-redundant) assume o túnel
IPsec hoje preso à VM; a 2ª VM é uma réplica idêntica da 1ª, sem estado
de rede próprio; Load Balancer Standard decide qual VM recebe cada
conexão nova via health probe. Nenhuma mudança de código nesta fase —
usa o que o Plano 1 já entregou (`isLeader()`, `/api/healthz`).

**Tech Stack:** Azure CLI (`az`), VPN Gateway, Load Balancer Standard,
VM `Standard_D2s_v3` (mesma SKU da VM1), certbot com plugin DNS (Azure
DNS) em vez de HTTP-01.

**Spec:** [docs/superpowers/specs/2026-11-27-ha-watchdog-design.md](../specs/2026-11-27-ha-watchdog-design.md)
(seções "A. Camada de rede" e "B. Camada de computação")

## Pré-requisito bloqueante

**Não começar a Task 4 (2ª VM) até o PR do Plano 1 estar mergeado em
`master` E implantado na VM de produção** (`/api/healthz` precisa
existir de verdade na VM antes do Load Balancer ter algo pra sondar).
Tasks 1-3 (Gateway + migração do túnel + certificado) não dependem disso
e podem rodar em paralelo/antes.

## Global Constraints

- Resource group: `rg-dt-manager` (minúsculo — confirmado via `az
  network vnet list`, região `brazilsouth`)
- VNet existente: `vm-dt-managerVNET` (`10.0.0.0/16`), 1 subnet hoje:
  `vm-dt-managerSubnet` (`10.0.0.0/24`) — **não mexer nela**
- VM1 (`vm-dt-manager`): IP público `pip-dt-manager` (Standard, Static,
  `20.226.33.21`) — hostname público continua
  `dt-manager.brazilsouth.cloudapp.azure.com`, só o que está atrás dele
  muda ao final deste plano (passa a ser o Load Balancer, não a VM
  direto)
- Túnel IPsec hoje existente (só 1): `azure-to-metro`, peer remoto
  `201.76.172.74`, `rightsubnet=192.168.14.0/24`, PSK já configurada em
  `/etc/ipsec.conf` na VM1 — **copiar a PSK exata pro Gateway, não gerar
  uma nova** (trocaria a autenticação do lado da loja também)
- SKU do Gateway: `VpnGw1AZ` ($0,21/h, zone-redundant — já aprovado por
  custo, ver spec)
- 2ª VM: mesma SKU (`Standard_D2s_v3`) e mesmo disco (`Premium SSD P15
  LRS`, 256GB) da VM1
- Load Balancer: SKU `Standard` (obrigatório — Basic não tem mais SLA
  nem é mais vendido), health probe em `GET /api/healthz`, porta 3847
  (mesma porta do Node — LB fala com o backend direto, TLS continua
  terminando em cada VM via nginx)
- Nenhum comando deste plano reinicia/desliga a VM1 de produção sem
  aviso prévio — ela serve tráfego real o tempo todo até o Load Balancer
  estar validado

## Review Focus

- **Janela de baixo risco pro túnel**: o `azure-to-metro` já está caído
  (peer remoto não completa IKE, achado 27/11) — migrar AGORA não
  interrompe nada que esteja funcionando; se ele tivesse subido de novo
  nesse meio tempo, a Task 2 precisa reconfirmar isso antes de mexer
- **Renovação de certificado durante a janela de 2 VMs**: se o
  certificado vencer entre a Task 4 (2ª VM ligada) e a Task 3 (DNS-01
  aplicado), a renovação via HTTP-01 pode cair na VM errada e falhar
  silenciosamente — por isso a Task 3 roda ANTES da Task 4 neste plano,
  não depois
- **IP do Gateway nunca pode ficar idêntico ao da VM1**: são recursos
  Azure distintos, mas confirmar explicitamente no fim da Task 1 que o
  IP do Gateway é diferente de `20.226.33.21` antes de passar pro André
  reconfigurar o roteador da loja
- **2ª VM não pode virar lider acidentalmente achando que é a única**:
  validar que ela aponta pro MESMO `DATABASE_URL` da VM1 antes de
  ligar — senão a eleição de líder do Plano 1 não tem efeito nenhum
  (cada uma disputando lock num banco diferente)
- **Corte de DNS/hostname pro Load Balancer**: validar que o Load
  Balancer responde `/api/healthz` com 200 ANTES de apontar o hostname
  público pra ele — nunca cortar tráfego real pra um LB ainda não
  validado

---

## Task 1: Provisionar o VPN Gateway

**Recursos a criar:**
- Subnet `GatewaySubnet` (nome exato, obrigatório pela Azure) dentro da
  VNet existente, prefixo `10.0.1.0/27` (não conflita com
  `10.0.0.0/24` já em uso)
- IP público `pip-vpngw-dt-manager` (Standard, Static, zonal-redundant)
- `az network vnet-gateway create`, SKU `VpnGw1AZ`, tipo `Vpn`,
  `RouteBased`

- [ ] **Step 1: Confirmar com o André antes de criar qualquer recurso**
  (custo entra em ~$153/mês assim que o Gateway existe, mesmo sem
  túnel configurado ainda)

- [ ] **Step 2: Criar a subnet do Gateway**

```bash
az network vnet subnet create \
  -g rg-dt-manager --vnet-name vm-dt-managerVNET \
  -n GatewaySubnet --address-prefix 10.0.1.0/27
```

- [ ] **Step 3: Criar o IP público do Gateway**

```bash
az network public-ip create \
  -g rg-dt-manager -n pip-vpngw-dt-manager \
  --sku Standard --allocation-method Static --zone 1 2 3
```

- [ ] **Step 4: Criar o Gateway (demora 30-45min, é normal)**

```bash
az network vnet-gateway create \
  -g rg-dt-manager -n vpngw-dt-manager \
  --vnet vm-dt-managerVNET \
  --public-ip-addresses pip-vpngw-dt-manager \
  --gateway-type Vpn --vpn-type RouteBased \
  --sku VpnGw1AZ --no-wait
```

- [ ] **Step 5: Aguardar e confirmar provisionado**

```bash
az network vnet-gateway show -g rg-dt-manager -n vpngw-dt-manager \
  --query "{state:provisioningState, ip:ipConfigurations[0].publicIpAddress.id}"
```
Expected: `provisioningState: Succeeded`

- [ ] **Step 6: Confirmar o IP público do Gateway é diferente do da VM1**

```bash
az network public-ip show -g rg-dt-manager -n pip-vpngw-dt-manager --query ipAddress -o tsv
```
Expected: um IP diferente de `20.226.33.21` — guardar esse IP, é o que
o André vai passar pro roteador da loja Metro na Task 2.

---

## Task 2: Migrar o túnel da loja Metro pro Gateway

**Pré-requisito**: ler a PSK atual direto da VM1 (nunca gerar uma nova)
e reconfirmar que o túnel continua caído (não interromper algo que
voltou a funcionar sozinho nesse meio tempo).

- [ ] **Step 1: Ler a config/PSK atual da VM1** (via `az vm run-command`,
  mesmo mecanismo já usado hoje — `cat /etc/ipsec.secrets` e
  `/etc/ipsec.conf`, seção `azure-to-metro`)

- [ ] **Step 2: Reconfirmar que o túnel segue caído**

```bash
az vm run-command invoke -g RG-DT-MANAGER -n vm-dt-manager \
  --command-id RunShellScript \
  --scripts "ipsec statusall 2>&1 | grep -A3 azure-to-metro"
```
Se voltou a subir sozinho: PARAR, avisar o André, não migrar um túnel
que está funcionando sem confirmar antes.

- [ ] **Step 3: Criar o Local Network Gateway (representa o peer da loja)**

```bash
az network local-gateway create \
  -g rg-dt-manager -n lgw-loja-metro \
  --gateway-ip-address 201.76.172.74 \
  --local-address-prefixes 192.168.14.0/24
```

- [ ] **Step 4: Criar a conexão S2S, mesma PSK lida no Step 1**

```bash
az network vpn-connection create \
  -g rg-dt-manager -n conn-loja-metro \
  --vnet-gateway1 vpngw-dt-manager \
  --local-gateway2 lgw-loja-metro \
  --shared-key "<PSK EXATA DO STEP 1>"
```

- [ ] **Step 5: Confirmar com o André — ele (ou quem administra o
  roteador da loja Metro) reconfigura o peer IP de `20.226.33.21` pro
  IP do Gateway (Task 1, Step 6), mesma PSK.** Esse passo é FORA desta
  sessão — depende de alguém com acesso ao roteador físico/admin da
  loja.

- [ ] **Step 6: Validar o túnel subiu**

```bash
az network vpn-connection show -g rg-dt-manager -n conn-loja-metro \
  --query "{status:connectionStatus}"
```
Expected: `Connected` (pode levar alguns minutos após o Step 5)

- [ ] **Step 7: Testar reachability de verdade**

```bash
az vm run-command invoke -g RG-DT-MANAGER -n vm-dt-manager \
  --command-id RunShellScript \
  --scripts "curl -sS -o /dev/null -w 'clockproxy:%{http_code} t:%{time_total}\n' --max-time 10 http://192.168.14.1:4321/rh/clocks/status"
```
Expected: resposta rápida (não mais o timeout de 10s que vimos hoje)

- [ ] **Step 8: Desligar o strongSwan da VM1** (só depois do Step 7
  confirmado — o Gateway assume o túnel, a VM não precisa mais dele)

```bash
az vm run-command invoke -g RG-DT-MANAGER -n vm-dt-manager \
  --command-id RunShellScript \
  --scripts "systemctl stop ipsec-watchdog-metro.timer ipsec-watchdog-metro.service; systemctl disable ipsec-watchdog-metro.timer; systemctl stop strongswan-starter 2>&1 || systemctl stop ipsec 2>&1"
```

- [ ] **Step 9: Validar reachability de novo depois de desligar o
  strongSwan da VM** (confirma que é o Gateway respondendo, não a VPN
  antiga ainda ativa por acidente) — repetir Step 7.

---

## Task 3: Trocar renovação de certificado TLS pra DNS-01

**Por quê agora, antes da 2ª VM**: com 2 VMs atrás do LB, um desafio
HTTP-01 pode cair na VM errada e falhar silenciosamente. DNS-01 não
depende de qual VM responde.

- [ ] **Step 1: Confirmar qual mecanismo de certificado está em uso
  hoje na VM1** (certbot? qual plugin?) — ler antes de assumir.

```bash
az vm run-command invoke -g RG-DT-MANAGER -n vm-dt-manager \
  --command-id RunShellScript \
  --scripts "certbot certificates 2>&1; crontab -l 2>&1 | grep -i certbot; cat /etc/letsencrypt/renewal/*.conf 2>&1"
```

- [ ] **Step 2: Instalar o plugin DNS da Azure pro certbot**

```bash
az vm run-command invoke -g RG-DT-MANAGER -n vm-dt-manager \
  --command-id RunShellScript \
  --scripts "pip3 install certbot-dns-azure 2>&1 || apt-get install -y python3-certbot-dns-azure 2>&1"
```
(builder confirma qual caminho de instalação existe na VM antes de
escolher)

- [ ] **Step 3: Configurar credenciais de uma Service Principal com
  permissão SÓ na zona DNS** (nunca a credencial de subscription
  inteira) — criar um SP escopado:

```bash
az ad sp create-for-rbac --name sp-certbot-dns-delirio \
  --role "DNS Zone Contributor" \
  --scopes /subscriptions/<sub-id>/resourceGroups/<rg-da-zona-dns>/providers/Microsoft.Network/dnszones/<zona>
```

- [ ] **Step 4: Rodar a renovação com `--dns-azure`, confirmar emissão OK,
  confirmar o cron/systemd timer de renovação foi atualizado pro novo
  método**

- [ ] **Step 5: Confirmar o certificado renovado é válido** (`openssl
  s_client` ou `curl -v` contra o hostname público, checar validade)

---

## Task 4: Provisionar a 2ª VM (passiva, sem tráfego ainda)

**Bloqueado até**: Plano 1 mergeado e implantado em produção (ver
"Pré-requisito bloqueante" no topo).

- [ ] **Step 1: Confirmar com o André antes de criar (custo ~$182/mês:
  VM + disco)**

- [ ] **Step 2: Criar a VM, mesma subnet da VM1, SEM IP público**
  (só o Load Balancer da Task 5 fala com ela de fora)

```bash
az vm create -g rg-dt-manager -n vm-dt-manager-2 \
  --image <mesma imagem da VM1, confirmar com az vm show> \
  --size Standard_D2s_v3 \
  --vnet-name vm-dt-managerVNET --subnet vm-dt-managerSubnet \
  --public-ip-address "" \
  --os-disk-size-gb 256 --storage-sku Premium_LRS \
  --admin-username <mesmo padrão da VM1>
```

- [ ] **Step 3: Replicar o deploy** — mesmo `/opt/dt-manager`, mesmo
  `ecosystem.config.js` da VM1 (inclusive **o mesmo `DATABASE_URL`** —
  ver Review Focus), mesmo mecanismo de deploy (`ci-server.yml`/
  `safe-restart.sh`)

- [ ] **Step 4: Validar a VM2 sobe e responde localmente**

```bash
az vm run-command invoke -g rg-dt-manager -n vm-dt-manager-2 \
  --command-id RunShellScript \
  --scripts "curl -sS http://127.0.0.1:3847/api/healthz"
```
Expected: `{"ok":true}`

- [ ] **Step 5: Validar a VM2 NÃO vira líder enquanto a VM1 já é** (ela
  deve ficar passiva — `isLeader()` falso nela enquanto a VM1 segura o
  advisory lock) — checar via log/endpoint que o Plano 1 expôs

---

## Task 5: Load Balancer + corte de DNS

- [ ] **Step 1: Confirmar com o André antes de criar (custo ~$20/mês)**

- [ ] **Step 2: Criar o Load Balancer Standard, IP próprio** (reaproveitar
  um novo IP Standard, não o `pip-dt-manager` da VM1 — esse fica livre
  pra desassociar da VM1 depois)

- [ ] **Step 3: Backend pool com as 2 VMs, health probe `GET
  /api/healthz` porta 3847, regra de balanceamento porta 443→3847 (TLS
  passthrough, nginx de cada VM termina)**

- [ ] **Step 4: Validar o LB responde 200 em `/api/healthz` batendo no
  IP dele diretamente** (antes de tocar DNS)

- [ ] **Step 5: Confirmar com o André — só agora cortar o hostname
  público pro IP do Load Balancer** (TTL baixo, reversível rápido se
  algo der errado)

- [ ] **Step 6: Validar de fora** (`curl` no hostname público, confirmar
  responde via LB)

---

## Task 6: Teste de falha real

- [ ] **Step 1: Confirmar com o André o horário pra esse teste** (vai
  derrubar uma VM de propósito — fazer em horário de menor tráfego ou
  com o André ciente e de prontidão)

- [ ] **Step 2: Derrubar a VM1 de propósito** (`az vm stop` ou matar o
  processo Node direto)

- [ ] **Step 3: Confirmar zero requisição nova perdida** (LB desvia pra
  VM2 assim que o health probe falha)

- [ ] **Step 4: Confirmar a VM2 assumiu a liderança** (jobs de fundo
  continuam rodando, sem duplicar)

- [ ] **Step 5: Religar a VM1, confirmar ela volta como passiva** (não
  disputa/reassume liderança de forma que duplique nada no meio do
  caminho)

- [ ] **Step 6: Documentar o resultado** — se tudo passou, este plano
  está completo; achados viram entrada na base de conhecimento de
  incidentes (prepara o terreno pro Plano 3)

## Self-Review

**Cobertura do spec**: seções A (VPN Gateway) e B (2 VMs + LB) da spec
cobertas pelas 6 tasks. O item "C. Eleição de líder" já foi entregue no
Plano 1 — aqui só se valida que funciona com 2 instâncias de verdade
(Task 4 Step 5, Task 6). Agente de vigilância fica pro Plano 3.

**Proporção**: plano é majoritariamente comandos `az` com valores reais
(subscription/resource group/SKU já confirmados ao vivo), não pseudo-
código — proporcional ao tipo de trabalho (infra, não software).

**Review Focus**: as 5 situações do topo têm um passo de validação
dedicado em alguma task (túnel caído → Task 2 Step 2; cert durante
janela de 2 VMs → Task 3 roda antes da Task 4; IP do Gateway diferente
→ Task 1 Step 6; DATABASE_URL da VM2 → Task 4 Step 2/5; corte de DNS
só após validar → Task 5 Step 4-5).
