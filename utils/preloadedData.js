/**
 * 预加载数据工具
 * 用于加载和查询预解析的CSV数据
 */

const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

const CACHE_DIR = path.join(__dirname, '../cache');

// 内存缓存
let preloadedData = {};
// 村级索引：采用懒加载 + LRU
// 默认预加载 1 个年份（当前所选）的村级索引，访问其他年份时再加载
// 限制最多同时缓存 2 个年份的索引（避免内存爆炸）
const VILLAGE_INDEX_MAX = 2;
let villageIndexCache = {};
let villageIndexLoadOrder = []; // LRU 顺序

/**
 * 加载预解析数据（同步加载）
 */
function loadPreloadedData(year) {
    const cacheKey = `preloaded_${year}`;

    if (preloadedData[cacheKey]) {
        return preloadedData[cacheKey];
    }

    const dataPath = path.join(CACHE_DIR, `${cacheKey}.json`);

    if (!fs.existsSync(dataPath)) {
        logger.warn(`预解析数据文件不存在: ${dataPath}`);
        return null;
    }

    try {
        const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
        preloadedData[cacheKey] = data;
        logger.debug(`已加载预解析数据: ${year}年`);
        return data;
    } catch (err) {
        logger.error(`加载预解析数据失败: ${err.message}`);
        return null;
    }
}

/**
 * 加载村级编码索引（懒加载 + LRU）
 * 同时只保留 VILLAGE_INDEX_MAX 个年份的索引在内存
 */
function loadVillageIndex(year) {
    const cacheKey = `village_index_${year}`;

    if (villageIndexCache[cacheKey]) {
        // LRU：移到最近
        const idx = villageIndexLoadOrder.indexOf(cacheKey);
        if (idx > 0) {
            villageIndexLoadOrder.splice(idx, 1);
            villageIndexLoadOrder.push(cacheKey);
        }
        return villageIndexCache[cacheKey];
    }

    const dataPath = path.join(CACHE_DIR, `${cacheKey}.json`);
    const gzPath = `${dataPath}.gz`;

    let raw;
    if (fs.existsSync(dataPath)) {
        raw = fs.readFileSync(dataPath, 'utf8');
    } else if (fs.existsSync(gzPath)) {
        // 压缩备份，实时解压
        const zlib = require('zlib');
        raw = zlib.gunzipSync(fs.readFileSync(gzPath)).toString('utf8');
    } else {
        logger.warn(`村级索引文件不存在: ${dataPath}`);
        return null;
    }

    try {
        const data = JSON.parse(raw);
        villageIndexCache[cacheKey] = data;
        villageIndexLoadOrder.push(cacheKey);

        // 超过限制则淘汰最久未用的
        while (villageIndexLoadOrder.length > VILLAGE_INDEX_MAX) {
            const evictKey = villageIndexLoadOrder.shift();
            delete villageIndexCache[evictKey];
            logger.debug(`淘汰村级索引缓存: ${evictKey}`);
        }

        logger.info(`已加载村级索引: ${year}年 (缓存数: ${villageIndexLoadOrder.length})`);
        return data;
    } catch (err) {
        logger.error(`加载村级索引失败: ${err.message}`);
        return null;
    }
}

/**
 * 获取省份列表
 */
function getProvinces(year) {
    const data = loadPreloadedData(year);
    return data?.provinces || [];
}

/**
 * 获取某省的城市列表
 */
function getCities(year, province) {
    const data = loadPreloadedData(year);
    if (!data || !data.cities || !data.cities[province]) {
        return [];
    }
    return data.cities[province];
}

/**
 * 获取某市的县列表
 */
function getCounties(year, province, city) {
    const data = loadPreloadedData(year);
    const key = `${province}_${city}`;
    if (!data || !data.counties || !data.counties[key]) {
        return [];
    }
    return data.counties[key];
}

/**
 * 获取某县的乡镇列表
 */
function getTowns(year, province, city, county) {
    const data = loadPreloadedData(year);
    const key = `${province}_${city}_${county}`;
    if (!data || !data.towns || !data.towns[key]) {
        return [];
    }
    return data.towns[key];
}

/**
 * 获取某乡镇的村列表
 */
function getVillages(year, province, city, county, town) {
    const data = loadPreloadedData(year);
    if (!data || !data.tree || !data.tree[province] ||
        !data.tree[province][city] || !data.tree[province][city][county]) {
        return [];
    }
    const villages = data.tree[province][city][county][town];
    if (!villages || !Array.isArray(villages)) {
        return [];
    }
    // 转换为统一格式
    return villages.map(v => ({
        name: v.name,
        code: v.code,
        province,
        city,
        county,
        town
    }));
}

/**
 * 获取完整树状结构
 */
function getTree(year, province) {
    const data = loadPreloadedData(year);
    if (!data || !data.tree || !data.tree[province]) {
        return null;
    }

    // 转换为数组格式
    const tree = data.tree[province];
    const result = [];

    for (const [shiName, shiData] of Object.entries(tree)) {
        const shiItem = {
            name: shiName,
            code: getCityCode(year, province, shiName),
            counties: []
        };

        for (const [xianName, xianData] of Object.entries(shiData)) {
            const xianItem = {
                name: xianName,
                code: getCountyCode(year, province, shiName, xianName),
                towns: []
            };

            for (const [xiangName, villages] of Object.entries(xianData)) {
                const xiangItem = {
                    name: xiangName,
                    code: getTownCode(year, province, shiName, xianName, xiangName),
                    villages: villages
                };
                xianItem.towns.push(xiangItem);
            }

            shiItem.counties.push(xianItem);
        }

        result.push(shiItem);
    }

    return result;
}

/**
 * 辅助函数：获取城市编码
 */
function getCityCode(year, province, city) {
    const cities = getCities(year, province);
    const found = cities.find(c => c.name === city);
    return found?.code || '';
}

/**
 * 辅助函数：获取县编码
 */
function getCountyCode(year, province, city, county) {
    const counties = getCounties(year, province, city);
    const found = counties.find(c => c.name === county);
    return found?.code || '';
}

/**
 * 辅助函数：获取乡镇编码
 */
function getTownCode(year, province, city, county, town) {
    const towns = getTowns(year, province, city, county);
    const found = towns.find(t => t.name === town);
    return found?.code || '';
}

/**
 * 搜索行政区划
 */
function search(year, keyword, limit = 10) {
    const data = loadPreloadedData(year);
    if (!data) return [];

    const results = [];
    const lowerKeyword = keyword.toLowerCase();

    // 搜索省份
    for (const p of data.provinces) {
        if (p.name.toLowerCase().includes(lowerKeyword) ||
            p.code.includes(keyword)) {
            results.push({ ...p, level: 'province' });
            if (results.length >= limit) return results;
        }
    }

    // 搜索城市
    for (const [province, cities] of Object.entries(data.cities)) {
        for (const c of cities) {
            if (c.name.toLowerCase().includes(lowerKeyword) ||
                c.code.includes(keyword)) {
                results.push({ ...c, level: 'city' });
                if (results.length >= limit) return results;
            }
        }
    }

    // 搜索县
    for (const [key, counties] of Object.entries(data.counties)) {
        for (const c of counties) {
            if (c.name.toLowerCase().includes(lowerKeyword) ||
                c.code.includes(keyword)) {
                results.push({ ...c, level: 'county' });
                if (results.length >= limit) return results;
            }
        }
    }

    return results;
}

/**
 * 获取统计信息
 */
function getStats(year) {
    const data = loadPreloadedData(year);
    return data?.stats || null;
}

/**
 * 根据村级编码获取村信息
 * @param {string} code - 12位村级编码
 * @param {number} year - 年份，默认2023
 */
function getVillageByCode(code, year = 2023) {
    if (!code || code.length < 12) {
        return null;
    }

    const villageIndex = loadVillageIndex(year);
    if (!villageIndex) {
        return null;
    }

    // 提取县编码（前6位）
    const xianCode = code.substring(0, 6);
    const xianVillages = villageIndex[xianCode];

    if (!xianVillages) {
        return null;
    }

    // 精确匹配编码
    const exactMatch = xianVillages.find(v => v.code === code);
    if (exactMatch) {
        return exactMatch;
    }

    // 模糊匹配：前9位（乡镇编码）匹配，但要求精确匹配村级
    const xiangCode = code.substring(0, 9);
    const xiangMatch = xianVillages.find(v => v.code && v.code.length === 12 && v.code.substring(0, 9) === xiangCode && v.code !== code);
    if (xiangMatch) {
        return xiangMatch;
    }

    return null;
}

/**
 * 预加载常用年份数据到内存（异步，不阻塞启动）
 * 注意：村级索引采用懒加载，不预加载（节省 400M+ 内存）
 */
function preloadAll() {
    setImmediate(() => {
        const years = [2023, 2021, 2018, 2017, 2010];
        for (const year of years) {
            try {
                loadPreloadedData(year);
                // 村级索引仅预加载最近 1 个年份（2023），其它年份按需懒加载
                if (year === 2023) {
                    loadVillageIndex(year);
                }
            } catch (err) {
                logger.warn(`预加载失败: ${year}年 - ${err.message}`);
            }
        }
        logger.info('常用年份预加载完成（村级索引仅预加载 2023 年）');
    });
}

module.exports = {
    loadPreloadedData,
    getProvinces,
    getCities,
    getCounties,
    getTowns,
    getVillages,
    getTree,
    search,
    getStats,
    getVillageByCode,
    preloadAll
};