#!/bin/bash
# 每日清理 PM2 日志脚本
# 保留最近1天的日志，防止日志文件过大导致磁盘满

set -e

LOG_FILE="/opt/1panel/apps/openresty/openresty/www/wwwroot/map.ruiduobao.com/cleanup.log"

echo "========================================" >> "$LOG_FILE"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 开始每日 PM2 日志清理" >> "$LOG_FILE"

# 记录清理前的日志大小和磁盘空间
BEFORE_LOG_SIZE=$(du -sh /root/.pm2/logs/ 2>/dev/null | awk '{print $1}')
BEFORE_SPACE=$(df -h / | tail -1 | awk '{print $4}')
echo "清理前 PM2日志大小: $BEFORE_LOG_SIZE, 磁盘可用: $BEFORE_SPACE" >> "$LOG_FILE"

# 使用 pm2 flush 清空所有日志
pm2 flush >> "$LOG_FILE" 2>&1 || true

# 记录清理后
AFTER_LOG_SIZE=$(du -sh /root/.pm2/logs/ 2>/dev/null | awk '{print $1}')
AFTER_SPACE=$(df -h / | tail -1 | awk '{print $4}')
echo "清理后 PM2日志大小: $AFTER_LOG_SIZE, 磁盘可用: $AFTER_SPACE" >> "$LOG_FILE"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 每日日志清理完成" >> "$LOG_FILE"
echo "========================================" >> "$LOG_FILE"