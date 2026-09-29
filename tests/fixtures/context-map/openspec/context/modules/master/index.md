---
module: sds-master
description: Хранение данных сессии in-memory, жизненный цикл сессии, репликация
domains: [session-lifecycle, session-data, replication]   # имена папок из openspec/specs/
code_paths: [sds-master/src/main/java, sds-master-api]
depends_on: [sds-impl]      # автоматически предлагается к загрузке
---

# sds-master
