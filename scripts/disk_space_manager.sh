#!/bin/bash
# 智能磁盘空间管理脚本
# 基于磁盘空间阈值自动清理缓存和日志
# 使用LRU策略保留热门数据

set -e

# ============ 配置参数 ============
WEBROOT="/opt/1panel/apps/openresty/openresty/www/wwwroot/map.ruiduobao.com"
LOG_FILE="$WEBROOT/cleanup.log"
PID_FILE="$WEBROOT/scripts/.cleanup.pid"

# 磁盘空间阈值（百分比）
THRESHOLD_NORMAL=97    # 使用率 >= 97% (剩余 < 3%) 触发正常清理
THRESHOLD_EMERGENCY=98 # 使用率 >= 98% (剩余 < 2%) 触发紧急清理

# 磁盘空间阈值（绝对值 GB）
THRESHOLD_GB=1        # 可用空间 < 1G 触发紧急清理

# LRU策略配置
KEEP_DAYS=30           # 保留最近30天的文件
KEEP_MIN_FILES=500     # 最少保留500个热门文件

# 目录配置
VECTORDATA_DIR="$WEBROOT/public/vectordata"
CACHE_DIR="$WEBROOT/cache"
PM2_LOG_DIR="/root/.pm2/logs"

# ============ 辅助函数 ============

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

get_disk_usage() {
    df / | tail -1 | awk '{print $5}' | sed 's/%//'
}

get_disk_available() {
    df -h / | tail -1 | awk '{print $4}'
}

get_disk_available_gb() {
    df -BG / | tail -1 | awk '{print $4}' | tr -d 'G'
}

get_file_count() {
    local dir="$1"
    if [ -d "$dir" ]; then
        find "$dir" -type f | wc -l
    else
        echo 0
    fi
}

# ============ LRU清理策略 ============
# 按访问时间排序，删除最旧的文件，保留热门数据

lru_cleanup() {
    local dir="$1"
    local pattern="$2"
    local max_age_days="$3"
    local min_keep="$4"
    local cleanup_level="$5"  # "normal" 或 "emergency"

    if [ ! -d "$dir" ]; then
        log "目录不存在: $dir"
        return 0
    fi

    local total_files=$(find "$dir" -name "$pattern" -type f | wc -l)
    local deleted_count=0
    local dir_size_before=$(du -sh "$dir" 2>/dev/null | awk '{print $1}')

    log "LRU清理 [$cleanup_level]: $dir ($pattern)"
    log "  文件总数: $total_files, 目录大小: $dir_size_before"

    if [ "$cleanup_level" = "emergency" ]; then
        # 紧急清理：保留最近7天或最少100个文件
        max_age_days=7
        min_keep=100
    fi

    # 1. 清理超过max_age_days天的文件（LRU策略）
    local old_files=$(find "$dir" -name "$pattern" -type f -mtime +$max_age_days | wc -l)
    if [ "$old_files" -gt 0 ]; then
        find "$dir" -name "$pattern" -type f -mtime +$max_age_days -delete 2>/dev/null || true
        deleted_count=$((deleted_count + old_files))
        log "  已删除 $old_files 个超过 $max_age_days 天的文件"
    fi

    # 2. 如果文件数仍然超过阈值，按访问时间删除最旧的（保留最少min_keep个）
    local remaining=$(find "$dir" -name "$pattern" -type f | wc -l)
    if [ "$remaining" -gt "$min_keep" ]; then
        local to_delete=$((remaining - min_keep))
        # 按访问时间排序，删除最旧的文件
        find "$dir" -name "$pattern" -type f -printf '%A@ %p\n' | \
            sort -n | head -n $to_delete | cut -d' ' -f2- | \
            while read file; do
                rm -f "$file" 2>/dev/null || true
            done
        deleted_count=$((deleted_count + to_delete))
        log "  已删除 $to_delete 个最旧的文件（保留最少 $min_keep 个热门文件）"
    fi

    local dir_size_after=$(du -sh "$dir" 2>/dev/null | awk '{print $1}')
    local remaining_after=$(find "$dir" -name "$pattern" -type f | wc -l)
    log "  清理后: $remaining_after 个文件, 目录大小: $dir_size_after (删除: $deleted_count)"

    return $deleted_count
}

# ============ 清理函数 ============

normal_cleanup() {
    log "========================================"
    log "[正常清理] 磁盘使用率: $(get_disk_usage)%, 可用: $(get_disk_available)"

    # 1. vectordata缓存 - LRU清理（保留30天或最少500个）
    lru_cleanup "$VECTORDATA_DIR" "*.gson" $KEEP_DAYS $KEEP_MIN_FILES "normal"

    # 2. cache目录 - LRU清理
    lru_cleanup "$CACHE_DIR" "*.gson" $KEEP_DAYS $KEEP_MIN_FILES "normal"
    lru_cleanup "$CACHE_DIR" "*.json" $KEEP_DAYS $KEEP_MIN_FILES "normal"

    # 3. PM2日志 - 保留最近3天
    if [ -d "$PM2_LOG_DIR" ]; then
        local pm2_size_before=$(du -sh "$PM2_LOG_DIR" 2>/dev/null | awk '{print $1}')
        find "$PM2_LOG_DIR" -name "*.log" -mtime +3 -delete 2>/dev/null || true
        local pm2_size_after=$(du -sh "$PM2_LOG_DIR" 2>/dev/null | awk '{print $1}')
        log "PM2日志清理: $pm2_size_before -> $pm2_size_after"
    fi

    # 4. Redis缓存清理（保持一致性）
    local redis_deleted=0
    redis_deleted=$((redis_deleted + $(redis-cli KEYS "full_*" 2>/dev/null | xargs -r redis-cli DEL 2>/dev/null | grep -c "^[0-9]" || echo 0)))
    redis_deleted=$((redis_deleted + $(redis-cli KEYS "preloaded_*" 2>/dev/null | xargs -r redis-cli DEL 2>/dev/null | grep -c "^[0-9]" || echo 0)))
    log "Redis缓存清理: 删除 $redis_deleted 个键"

    log "[正常清理完成] 磁盘可用: $(get_disk_available)"
    log "========================================"
}

emergency_cleanup() {
    log "========================================"
    log "[紧急清理] 磁盘使用率: $(get_disk_usage)%, 可用: $(get_disk_available)"

    # 1. vectordata缓存 - 紧急LRU清理（保留7天或最少100个）
    lru_cleanup "$VECTORDATA_DIR" "*.gson" 7 100 "emergency"

    # 2. cache目录 - 紧急清理
    lru_cleanup "$CACHE_DIR" "*.gson" 7 100 "emergency"
    lru_cleanup "$CACHE_DIR" "*.json" 7 100 "emergency"

    # 3. PM2日志 - 清空所有日志（紧急情况）
    if [ -d "$PM2_LOG_DIR" ]; then
        pm2 flush >> "$LOG_FILE" 2>&1 || true
        # 直接删除日志文件（确保释放空间）
        rm -f "$PM2_LOG_DIR"/*.log 2>/dev/null || true
        log "PM2日志: 已清空所有日志"
    fi

    # 4. Redis - 清理所有缓存键
    redis-cli FLUSHDB 2>/dev/null || true
    log "Redis: 已清空所有缓存"

    # 5. 处理脚本临时文件
    find "$WEBROOT/处理脚本/data" -name "*.tmp" -delete 2>/dev/null || true
    find "$WEBROOT/处理脚本/data" -name "*.bak" -delete 2>/dev/null || true
    log "处理脚本临时文件: 已清理"

    # 6. 重启应用（确保缓存一致性）
    pm2 restart map.ruiduobao.com >> "$LOG_FILE" 2>&1 || true
    log "应用已重启"

    log "[紧急清理完成] 磁盘可用: $(get_disk_available)"
    log "========================================"
}

# ============ 主程序 ============

# 防止重复执行
if [ -f "$PID_FILE" ]; then
    old_pid=$(cat "$PID_FILE")
    if ps -p $old_pid > /dev/null 2>&1; then
        log "清理脚本已在运行 (PID: $old_pid)，跳过"
        exit 0
    fi
fi
echo $$ > "$PID_FILE"

# 获取当前磁盘使用率和可用空间（GB）
disk_usage=$(get_disk_usage)
disk_available_gb=$(get_disk_available_gb)

log "检查磁盘空间: 使用率 ${disk_usage}%, 可用 ${disk_available_gb}G"

# 首先检查绝对值阈值（低于1G直接紧急清理）
if [ "$disk_available_gb" -lt "$THRESHOLD_GB" ]; then
    log "⚠️ 可用空间仅 ${disk_available_gb}G，低于阈值 ${THRESHOLD_GB}G！"
    emergency_cleanup
elif [ "$disk_usage" -ge "$THRESHOLD_EMERGENCY" ]; then
    emergency_cleanup
elif [ "$disk_usage" -ge "$THRESHOLD_NORMAL" ]; then
    normal_cleanup
else
    log "磁盘空间充足 (${disk_usage}% < ${THRESHOLD_NORMAL}%, 可用 ${disk_available_gb}G)，无需清理"
fi

# 清理完成后删除PID文件
rm -f "$PID_FILE"