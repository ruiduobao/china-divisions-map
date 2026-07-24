/**
 * 矢量数据缓存管理服务
 *
 * 职责：
 * 1. 维护 public/vectordata/ 目录的容量（默认 ≤ 1.5G / 5万文件）
 * 2. 按 mtime 删除最旧文件
 * 3. 保存新文件后立即检查容量
 *
 * 配置：
 *   village.cache.maxFiles    默认 50000
 *   village.cache.maxSizeMB   默认 1500
 */

const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { logger } = require('../utils/logger');

const CACHE_DIR = path.join(__dirname, '../public/vectordata');

/**
 * 检查并清理矢量缓存
 *  - 如果文件数 > maxFiles，按 mtime 删最旧
 *  - 如果总大小 > maxSizeMB，按 mtime 删最旧
 *  - 保留至少 60 分钟内创建的（避免删除正在用的）
 */
function cleanupVectorCache(options = {}) {
    const maxFiles = options.maxFiles ?? config.village?.cache?.maxFiles ?? 50000;
    const maxSizeMB = options.maxSizeMB ?? config.village?.cache?.maxSizeMB ?? 1500;
    const maxSizeBytes = maxSizeMB * 1024 * 1024;
    const protectMs = options.protectMs ?? 60 * 60 * 1000; // 1 小时

    if (!fs.existsSync(CACHE_DIR)) {
        return { removed: 0, reason: 'cache dir not found' };
    }

    let files;
    try {
        files = fs.readdirSync(CACHE_DIR)
            .filter(f => f.endsWith('.gson'))
            .map(f => {
                const fp = path.join(CACHE_DIR, f);
                try {
                    const st = fs.statSync(fp);
                    return { name: f, path: fp, mtime: st.mtimeMs, size: st.size };
                } catch {
                    return null;
                }
            })
            .filter(Boolean);
    } catch (err) {
        logger.warn('读取 vectordata 目录失败: %s', err.message);
        return { removed: 0, error: err.message };
    }

    const fileCount = files.length;
    const totalSize = files.reduce((s, f) => s + f.size, 0);
    let removed = 0;
    const now = Date.now();

    // 按 mtime 升序
    files.sort((a, b) => a.mtime - b.mtime);

    // 是否需要清理
    const needClean = fileCount > maxFiles || totalSize > maxSizeBytes;

    if (!needClean) {
        return { removed: 0, fileCount, totalSize };
    }

    // 先按 size 清理，删到 maxSize 以下
    let sizeLeft = totalSize;
    for (const f of files) {
        if (sizeLeft <= maxSizeBytes * 0.85) break; // 保留 15% 余量
        if (now - f.mtime < protectMs) continue;     // 保护 1 小时内的新文件

        try {
            fs.unlinkSync(f.path);
            sizeLeft -= f.size;
            removed++;
        } catch (err) {
            logger.warn('删除缓存文件失败 %s: %s', f.name, err.message);
        }
    }

    // 再按数量清理（理论上前面已清完，兜底）
    let countLeft = fileCount - removed;
    for (const f of files) {
        if (countLeft <= maxFiles * 0.85) break;
        if (now - f.mtime < protectMs) continue;
        if (fs.existsSync(f.path)) {
            try {
                fs.unlinkSync(f.path);
                countLeft--;
                removed++;
            } catch (err) {}
        }
    }

    logger.info('vectordata 缓存清理: 移除 %d 个文件, 释放 %.1f MB, 剩余 %d 个文件 / %.1f MB',
        removed,
        (totalSize - sizeLeft) / 1024 / 1024,
        fileCount - removed,
        sizeLeft / 1024 / 1024);

    return { removed, fileCount, totalSize, totalSizeMB: totalSize / 1024 / 1024 };
}

/**
 * 保存矢量文件，并在保存后检查容量
 */
function saveVectorFile(id, geojson) {
    const filepath = path.join(CACHE_DIR, `${id}.gson`);
    try {
        fs.writeFileSync(filepath, JSON.stringify(geojson));
        // 每 100 次写入触发一次清理
        if (Math.random() < 0.01) {
            setImmediate(cleanupVectorCache);
        }
        return `/vectordata/${id}.gson`;
    } catch (err) {
        logger.error('保存矢量文件失败 %s: %s', id, err.message);
        throw err;
    }
}

/**
 * 获取缓存统计
 */
function getCacheStats() {
    if (!fs.existsSync(CACHE_DIR)) {
        return { fileCount: 0, totalSizeMB: 0 };
    }
    try {
        const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.gson'));
        let totalSize = 0;
        for (const f of files) {
            try {
                totalSize += fs.statSync(path.join(CACHE_DIR, f)).size;
            } catch {}
        }
        return { fileCount: files.length, totalSizeMB: totalSize / 1024 / 1024 };
    } catch (err) {
        return { fileCount: 0, totalSizeMB: 0, error: err.message };
    }
}

module.exports = {
    cleanupVectorCache,
    saveVectorFile,
    getCacheStats,
    CACHE_DIR
};
