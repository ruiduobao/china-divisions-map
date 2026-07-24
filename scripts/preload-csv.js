/**
 * CSV预解析脚本
 * 将CSV文件预解析为JSON格式，提升API响应速度
 *
 * 使用方法: node scripts/preload-csv.js
 */

const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const iconv = require('iconv-lite');
const { logger } = require('../utils/logger');

const CSV_DIR = path.join(__dirname, '../处理脚本/data/修改后的csv文件');
const OUTPUT_DIR = path.join(__dirname, '../cache');

// 确保输出目录存在
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

/**
 * 预解析单个年份的CSV文件
 */
async function parseYearCSV(year) {
    const csvPath = path.join(CSV_DIR, `2.生成的数据位一到五级(含编码)${year}.csv`);

    if (!fs.existsSync(csvPath)) {
        logger.warn(`CSV文件不存在: ${csvPath}`);
        return null;
    }

    logger.info(`开始解析 ${year} 年数据...`);
    const startTime = Date.now();

    // 存储结构化数据
    const data = {
        provinces: new Map(),      // 省份列表
        cities: new Map(),         // 各省的城市列表
        counties: new Map(),       // 各市的县列表
        towns: new Map(),          // 各县的乡镇列表
        villageIndex: new Map(),   // 村级编码索引（编码 -> 村信息）
        tree: {}                   // 完整树状结构
    };

    return new Promise((resolve, reject) => {
        fs.createReadStream(csvPath)
            .pipe(iconv.decodeStream('utf8'))
            .pipe(csv())
            .on('data', (row) => {
                const sheng = row['省'] || '';
                const shi = row['市'] || '';
                const xian = row['县'] || '';
                const xiang = row['乡'] || '';
                const cun = row['村'] || '';
                const code = row['编码'] || '';

                // 省份
                if (sheng && !data.provinces.has(sheng)) {
                    const shengCode = code ? code.substring(0, 2) + '0000' : '';
                    data.provinces.set(sheng, { name: sheng, code: shengCode });
                }

                // 城市
                if (sheng && shi) {
                    const cityKey = `${sheng}_${shi}`;
                    if (!data.cities.has(cityKey)) {
                        const shiCode = code ? code.substring(0, 4) + '00' : '';
                        data.cities.set(cityKey, {
                            name: shi,
                            code: shiCode,
                            province: sheng
                        });
                    }
                }

                // 县
                if (sheng && shi && xian) {
                    const countyKey = `${sheng}_${shi}_${xian}`;
                    if (!data.counties.has(countyKey)) {
                        const xianCode = code ? code.substring(0, 6) : '';
                        data.counties.set(countyKey, {
                            name: xian,
                            code: xianCode,
                            province: sheng,
                            city: shi
                        });
                    }
                }

                // 乡镇
                if (sheng && shi && xian && xiang) {
                    const townKey = `${sheng}_${shi}_${xian}_${xiang}`;
                    if (!data.towns.has(townKey)) {
                        const xiangCode = code ? code.substring(0, 9) + '000' : '';
                        data.towns.set(townKey, {
                            name: xiang,
                            code: xiangCode,
                            province: sheng,
                            city: shi,
                            county: xian
                        });
                    }
                }

                // 村级编码索引
                if (code && cun && code.length >= 12) {
                    data.villageIndex.set(code, {
                        sheng, shi, xian, xiang, cun, code
                    });
                }

                // 构建树状结构
                if (sheng) {
                    if (!data.tree[sheng]) {
                        data.tree[sheng] = {};
                    }
                    if (shi && !data.tree[sheng][shi]) {
                        data.tree[sheng][shi] = {};
                    }
                    if (shi && xian && !data.tree[sheng][shi][xian]) {
                        data.tree[sheng][shi][xian] = {};
                    }
                    if (shi && xian && xiang && !data.tree[sheng][shi][xian][xiang]) {
                        data.tree[sheng][shi][xian][xiang] = [];
                    }
                    if (shi && xian && xiang && cun) {
                        data.tree[sheng][shi][xian][xiang].push({
                            name: cun,
                            code: code
                        });
                    }
                }
            })
            .on('end', () => {
                const duration = Date.now() - startTime;

                // 转换为数组格式
                const result = {
                    year,
                    provinces: Array.from(data.provinces.values()),
                    cities: Object.fromEntries(
                        groupByProvince(Array.from(data.cities.values()))
                    ),
                    counties: Object.fromEntries(
                        groupByCity(Array.from(data.counties.values()))
                    ),
                    towns: Object.fromEntries(
                        groupByCounty(Array.from(data.towns.values()))
                    ),
                    tree: data.tree,
                    stats: {
                        provinces: data.provinces.size,
                        cities: data.cities.size,
                        counties: data.counties.size,
                        towns: data.towns.size,
                        villages: data.villageIndex.size
                    }
                };

                logger.info(`${year}年数据解析完成: ${result.stats.provinces}省, ${result.stats.cities}市, ${result.stats.counties}县, ${result.stats.towns}乡镇, ${result.stats.villages}村, 耗时${duration}ms`);

                // 返回村级索引（单独处理）
                resolve({ result, villageIndex: data.villageIndex });
            })
            .on('error', reject);
    });
}

/**
 * 按省份分组城市
 */
function groupByProvince(cities) {
    const grouped = new Map();
    for (const city of cities) {
        if (!grouped.has(city.province)) {
            grouped.set(city.province, []);
        }
        grouped.get(city.province).push(city);
    }
    return grouped;
}

/**
 * 按城市分组县
 */
function groupByCity(counties) {
    const grouped = new Map();
    for (const county of counties) {
        const key = `${county.province}_${county.city}`;
        if (!grouped.has(key)) {
            grouped.set(key, []);
        }
        grouped.get(key).push(county);
    }
    return grouped;
}

/**
 * 按县分组乡镇
 */
function groupByCounty(towns) {
    const grouped = new Map();
    for (const town of towns) {
        const key = `${town.province}_${town.city}_${town.county}`;
        if (!grouped.has(key)) {
            grouped.set(key, []);
        }
        grouped.get(key).push(town);
    }
    return grouped;
}

/**
 * 保存预解析数据
 */
function savePreloadedData(year, data, villageIndex) {
    const outputPath = path.join(OUTPUT_DIR, `preloaded_${year}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf8');
    const fileSize = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(2);
    logger.info(`已保存: ${outputPath} (${fileSize} MB)`);

    // 保存村级编码索引（单独文件，按县分组）
    const villageIndexData = {};
    for (const [code, info] of villageIndex) {
        const xianCode = code.substring(0, 6);
        if (!villageIndexData[xianCode]) {
            villageIndexData[xianCode] = [];
        }
        villageIndexData[xianCode].push(info);
    }

    const villageIndexPath = path.join(OUTPUT_DIR, `village_index_${year}.json`);
    fs.writeFileSync(villageIndexPath, JSON.stringify(villageIndexData), 'utf8');
    const villageFileSize = (fs.statSync(villageIndexPath).size / 1024 / 1024).toFixed(2);
    logger.info(`已保存村级索引: ${villageIndexPath} (${villageFileSize} MB)`);
}

/**
 * 生成快速索引文件
 */
function generateQuickIndex(years) {
    const index = {
        years: years,
        provinces: {}
    };

    for (const year of years) {
        const dataPath = path.join(OUTPUT_DIR, `preloaded_${year}.json`);
        if (fs.existsSync(dataPath)) {
            const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
            index.provinces[year] = data.provinces.map(p => p.name);
        }
    }

    const indexPath = path.join(OUTPUT_DIR, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');
    logger.info(`已生成索引文件: ${indexPath}`);
}

/**
 * 主函数
 */
async function main() {
    logger.info('========== CSV预解析开始 ==========');

    const years = [2023, 2021, 2018, 2017, 2010];
    const parsedYears = [];

    for (const year of years) {
        try {
            const { result, villageIndex } = await parseYearCSV(year);
            if (result) {
                savePreloadedData(year, result, villageIndex);
                parsedYears.push(year);
            }
        } catch (err) {
            logger.error(`解析 ${year} 年数据失败: ${err.message}`);
        }
    }

    // 生成快速索引
    generateQuickIndex(parsedYears);

    logger.info('========== CSV预解析完成 ==========');
}

// 执行
main().catch(err => {
    logger.error('预解析失败: %s', err.message);
    process.exit(1);
});