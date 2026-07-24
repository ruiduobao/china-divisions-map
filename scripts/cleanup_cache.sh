#!/bin/bash
# 清理 map.ruiduobao.com 缓存文件脚本
# 每天 2:00 执行

set -e

WEBROOT="/opt/1panel/apps/openresty/openresty/www/wwwroot/map.ruiduobao.com"
LOG_FILE="/opt/1panel/apps/openresty/openresty/www/wwwroot/map.ruiduobao.com/cleanup.log"

echo "========================================" >> "$LOG_FILE"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 开始清理缓存文件" >> "$LOG_FILE"

# 记录清理前的磁盘空间
BEFORE_SPACE=$(df -h / | tail -1 | awk '{print $4}')
echo "清理前可用空间: $BEFORE_SPACE" >> "$LOG_FILE"

# 1. vectordata 目录的 .gson 文件 - 超出容量时按 mtime 删旧
# 用户设置：vectordata ≤ 1.5G / 5万文件（硬上限）
# vectordata + cache 总和需 ≤ 2G
VECTORDATA_DIR="$WEBROOT/public/vectordata"
VECTORDATA_MAX_FILES=50000
VECTORDATA_MAX_SIZE_MB=1500
VECTORDATA_PROTECT_MINUTES=60  # 保护 60 分钟内创建的（不删热文件）

if [ -d "$VECTORDATA_DIR" ]; then
    VECTORDATA_SIZE=$(du -sh "$VECTORDATA_DIR" 2>/dev/null | awk '{print $1}')
    VECTORDATA_COUNT=$(find "$VECTORDATA_DIR" -name "*.gson" -type f | wc -l)
    echo "vectordata 目录大小: $VECTORDATA_SIZE, 文件数: $VECTORDATA_COUNT" >> "$LOG_FILE"

    # 文件数超出 → 按 mtime 升序删旧（保护 60 分钟）
    if [ "$VECTORDATA_COUNT" -gt "$VECTORDATA_MAX_FILES" ]; then
        TARGET_DELETE=$((VECTORDATA_COUNT - VECTORDATA_MAX_FILES * 85 / 100))
        echo "  超出文件数限制 $VECTORDATA_MAX_FILES, 准备删除 $TARGET_DELETE 个旧文件" >> "$LOG_FILE"
        find "$VECTORDATA_DIR" -name "*.gson" -type f -mmin +$VECTORDATA_PROTECT_MINUTES \
            -printf '%T@ %p\n' 2>/dev/null | sort -n | head -n "$TARGET_DELETE" | awk '{print $2}' | while read f; do
            rm -f "$f" 2>/dev/null
        done
    fi

    # 容量超出 → 按 mtime 升序删旧
    VECTORDATA_SIZE_BYTES=$(du -sb "$VECTORDATA_DIR" 2>/dev/null | awk '{print $1}')
    VECTORDATA_MAX_BYTES=$((VECTORDATA_MAX_SIZE_MB * 1024 * 1024))
    if [ "$VECTORDATA_SIZE_BYTES" -gt "$VECTORDATA_MAX_BYTES" ]; then
        TARGET_BYTES=$((VECTORDATA_SIZE_BYTES - VECTORDATA_MAX_BYTES * 85 / 100))
        echo "  超出容量限制 ${VECTORDATA_MAX_SIZE_MB}MB, 准备释放 $((TARGET_BYTES/1024/1024))MB" >> "$LOG_FILE"
        DELETED=0
        while [ "$DELETED" -lt "$TARGET_BYTES" ]; do
            FILE=$(find "$VECTORDATA_DIR" -name "*.gson" -type f -mmin +$VECTORDATA_PROTECT_MINUTES \
                -printf '%T@ %p %s\n' 2>/dev/null | sort -n | head -1 | awk '{print $2}')
            if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then break; fi
            FSIZE=$(stat -c%s "$FILE" 2>/dev/null || echo 0)
            rm -f "$FILE" 2>/dev/null
            DELETED=$((DELETED + FSIZE))
        done
    fi

    VECTORDATA_SIZE_AFTER=$(du -sh "$VECTORDATA_DIR" 2>/dev/null | awk '{print $1}')
    VECTORDATA_COUNT_AFTER=$(find "$VECTORDATA_DIR" -name "*.gson" -type f | wc -l)
    echo "  清理后: 大小 $VECTORDATA_SIZE_AFTER, 文件数 $VECTORDATA_COUNT_AFTER" >> "$LOG_FILE"
fi

# 2. 清理 cache 目录中的 .gson 和 .json 缓存文件
# 注意: provinces 子目录保存预生成的省份缓存，不清理
CACHE_DIR="$WEBROOT/cache"
if [ -d "$CACHE_DIR" ]; then
    CACHE_SIZE=$(du -sh "$CACHE_DIR" 2>/dev/null | awk '{print $1}')
    echo "cache 目录大小: $CACHE_SIZE" >> "$LOG_FILE"
    # 删除缓存文件，保留索引和脚本，但跳过 provinces 目录
    find "$CACHE_DIR" -name "*.gson" -type f -delete 2>/dev/null || true
    find "$CACHE_DIR" -name "full_*.json" -type f -delete 2>/dev/null || true
    find "$CACHE_DIR" -name "preloaded_*.json" -type f -delete 2>/dev/null || true
    # 清理 cache/provinces 以外的子目录缓存文件
    find "$CACHE_DIR" -mindepth 1 -maxdepth 1 -type d \( -name "provinces" \) -prune -o -type f -delete 2>/dev/null || true
    # 保留 village_index_2023.json（主索引），4 个历史年份以 .gz 形式存在
    # 如发现 village_index_2023.json 丢了，则从 .gz 恢复
    if [ ! -f "$CACHE_DIR/village_index_2023.json" ] && [ -f "$CACHE_DIR/village_index_2023.json.gz" ]; then
        gunzip -k -c "$CACHE_DIR/village_index_2023.json.gz" > "$CACHE_DIR/village_index_2023.json" 2>/dev/null || true
        echo "从 .gz 恢复 village_index_2023.json" >> "$LOG_FILE"
    fi
    echo "已清理 cache 目录缓存文件（保留 provinces 子目录）" >> "$LOG_FILE"
fi

# 3. 清理 Redis 缓存（重要！确保缓存一致性）
REDIS_KEYS_DELETED=0
REDIS_KEYS_DELETED=$((REDIS_KEYS_DELETED + $(redis-cli KEYS "full_*" | xargs -r redis-cli DEL 2>/dev/null | grep -c "^[0-9]" || echo 0)))
REDIS_KEYS_DELETED=$((REDIS_KEYS_DELETED + $(redis-cli KEYS "cities_*" | xargs -r redis-cli DEL 2>/dev/null | grep -c "^[0-9]" || echo 0)))
REDIS_KEYS_DELETED=$((REDIS_KEYS_DELETED + $(redis-cli KEYS "counties_*" | xargs -r redis-cli DEL 2>/dev/null | grep -c "^[0-9]" || echo 0)))
REDIS_KEYS_DELETED=$((REDIS_KEYS_DELETED + $(redis-cli KEYS "towns_*" | xargs -r redis-cli DEL 2>/dev/null | grep -c "^[0-9]" || echo 0)))
REDIS_KEYS_DELETED=$((REDIS_KEYS_DELETED + $(redis-cli KEYS "villages_*" | xargs -r redis-cli DEL 2>/dev/null | grep -c "^[0-9]" || echo 0)))
echo "已清理 Redis 缓存，删除 $REDIS_KEYS_DELETED 个键" >> "$LOG_FILE"

# 4. 清理处理脚本目录中的临时文件
SCRIPTS_DIR="$WEBROOT/处理脚本"
if [ -d "$SCRIPTS_DIR" ]; then
    SCRIPTS_SIZE=$(du -sh "$SCRIPTS_DIR" 2>/dev/null | awk '{print $1}')
    echo "处理脚本目录大小: $SCRIPTS_SIZE" >> "$LOG_FILE"
    # 删除 data 目录中的临时数据文件 (保留目录结构)
    if [ -d "$SCRIPTS_DIR/data" ]; then
        find "$SCRIPTS_DIR/data" -name "*.tmp" -type f -delete 2>/dev/null || true
        find "$SCRIPTS_DIR/data" -name "*.bak" -type f -delete 2>/dev/null || true
        find "$SCRIPTS_DIR/data" -name "*_backup*" -type f -delete 2>/dev/null || true
        echo "已清理 处理脚本/data 临时文件" >> "$LOG_FILE"
    fi
fi

# 5. 清理 PM2 日志 (保留最近7天)
PM2_LOG_DIR="/root/.pm2/logs"
if [ -d "$PM2_LOG_DIR" ]; then
    PM2_LOG_COUNT=$(find "$PM2_LOG_DIR" -name "*.log" -mtime +7 | wc -l)
    find "$PM2_LOG_DIR" -name "*.log" -mtime +7 -delete 2>/dev/null || true
    echo "已清理 PM2 旧日志文件 (>7天)，删除 $PM2_LOG_COUNT 个文件" >> "$LOG_FILE"
fi

# 记录清理后的磁盘空间
AFTER_SPACE=$(df -h / | tail -1 | awk '{print $4}')
echo "清理后可用空间: $AFTER_SPACE" >> "$LOG_FILE"

# 重启 Node.js 应用 (确保缓存重建)
pm2 restart map.ruiduobao.com >> "$LOG_FILE" 2>&1 || true

# Redis 配置允许继续运行 (防止磁盘满时报错)
redis-cli CONFIG SET stop-writes-on-bgsave-error no >> "$LOG_FILE" 2>&1 || true

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 清理完成" >> "$LOG_FILE"
echo "========================================" >> "$LOG_FILE"