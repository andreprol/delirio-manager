-- Tamanho real de cada tabela (dados + índices) no Postgres de producao,
-- pra descobrir o que mais pesa no banco. Rodar com psql.
SELECT
  relname AS tabela,
  pg_size_pretty(pg_total_relation_size(relid)) AS tamanho_total,
  pg_size_pretty(pg_relation_size(relid)) AS so_dados,
  pg_size_pretty(pg_total_relation_size(relid) - pg_relation_size(relid)) AS so_indices,
  n_live_tup AS linhas_aprox
FROM pg_catalog.pg_statio_user_tables
JOIN pg_stat_user_tables USING (relid)
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 20;

-- Crescimento diario aproximado das 4 tabelas candidatas (ultimos 14 dias)
SELECT 'nfce_index' AS tabela, to_char(indexed_at::timestamptz, 'YYYY-MM-DD') AS dia, count(*) AS linhas
FROM nfce_index WHERE indexed_at::timestamptz > now() - interval '14 days'
GROUP BY 2 ORDER BY 2 DESC;

SELECT 'ncr_monitor_emails' AS tabela, to_char(created_at::timestamptz, 'YYYY-MM-DD') AS dia, count(*) AS linhas,
  pg_size_pretty(sum(length(coalesce(xml_b64,'')))::bigint) AS xml_bytes_dia
FROM ncr_monitor_emails WHERE created_at::timestamptz > now() - interval '14 days'
GROUP BY 2 ORDER BY 2 DESC;

SELECT 'activity_log' AS tabela, to_char(captured_at::timestamptz, 'YYYY-MM-DD') AS dia, count(*) AS linhas
FROM activity_log WHERE captured_at::timestamptz > now() - interval '14 days'
GROUP BY 2 ORDER BY 2 DESC;
