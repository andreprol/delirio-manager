-- Up Migration
--
-- db_size_alerts_sent: cooldown do alerta de crescimento (services/
-- dbSizeMonitor.js) -- achado do code-reviewer (17/11/2026): sem isto,
-- uma tabela que cruza o threshold e fica "deitada" acima dele (caso comum,
-- era exatamente o cenário do xml_b64 que motivou esta feature) manda o
-- MESMO e-mail todo dia às 01:30 pra sempre, inclusive a cada boot/deploy --
-- treina a ignorar o alerta, o mesmo mecanismo de falha que motivou
-- construir isto. 1 linha por tabela, upsert a cada envio real.
CREATE TABLE db_size_alerts_sent (
  table_name     TEXT PRIMARY KEY,
  alerted_at     TEXT NOT NULL,
  bytes_at_alert BIGINT NOT NULL
);

-- Down Migration

DROP TABLE IF EXISTS db_size_alerts_sent;
