#!/usr/bin/env node
/**
 * 预生成省份缓存文件脚本
 * 为所有31个省份生成树状数据缓存文件，避免用户首次访问时等待
 * 
 * 用法: node prebuild_province_cache.js [year]
 * 默认年份: 2023
 */

const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const iconv = require('iconv-lite');

const CSV_DIR = path.join(__dirname, '../处理脚本/data/修改后的csv文件');
const CACHE_DIR = path.join(__dirname, '../cache');
const PROVINCES_DIR = path.join(CACHE_DIR, 'provinces');

// 中国31个省份列表
const PROVINCES = [
    '北京市', '天津市', '河北省', '山西省', '内蒙古自治区',
    '辽宁省', '吉林省', '黑龙江省',
    '上海市', '江苏省', '浙江省', '安徽省', '福建省', '江西省', '山东省',
    '河南省', '湖北省', '湖南省', '广东省', '广西壮族自治区', '海南省',
    '重庆市', '四川省', '贵州省', '云南省', '西藏自治区',
    '陕西省', '甘肃省', '青海省', '宁夏回族自治区', '新疆维吾尔自治区'
];

// 支持的年份
const YEARS = ['2010', '2017', '2018', '2021', '2023'];

function getCSVPath(year) {
    return path.join(CSV_DIR, `2.生成的数据位一到五级(含编码)${year}.csv`);
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

async function loadFullTreeFromCSV(year, province) {
    const csvPath = getCSVPath(year);

    if (!fs.existsSync(csvPath)) {
        console.log(`  [警告] CSV文件不存在: ${csvPath}`);
        return null;
    }

    const tree = new Map();

    return new Promise((resolve, reject) => {
        fs.createReadStream(csvPath)
            .pipe(iconv.decodeStream('utf8'))
            .pipe(csv())
            .on('data', (row) => {
                if (row['省'] === province) {
                    const shi = row['市'] || '';
                    const xian = row['县'] || '';
                    const xiang = row['乡'] || '';
                    const cun = row['村'] || '';
                    const code = row['编码'] || '';

                    if (!tree.has(shi)) {
                        tree.set(shi, {
                            name: shi,
                            code: code.substring(0, 4) + '00',
                            counties: new Map()
                        });
                    }

                    if (xian && !tree.get(shi).counties.has(xian)) {
                        tree.get(shi).counties.set(xian, {
                            name: xian,
                            code: code.substring(0, 6),
                            towns: new Map()
                        });
                    }

                    if (xian && xiang && !tree.get(shi).counties.get(xian).towns.has(xiang)) {
                        tree.get(shi).counties.get(xian).towns.set(xiang, {
                            name: xiang,
                            code: code.substring(0, 9) + '000',
                            villages: []
                        });
                    }

                    if (xian && xiang && cun) {
                        tree.get(shi).counties.get(xian).towns.get(xiang).villages.push({
                            name: cun,
                            code: code
                        });
                    }
                }
            })
            .on('end', () => {
                const result = Array.from(tree.values())
                    .filter(shi => shi.name && shi.name.trim() !== '')
                    .map(shi => ({
                        name: shi.name,
                        code: shi.code,
                        counties: Array.from(shi.counties.values()).map(xian => ({
                            name: xian.name,
                            code: xian.code,
                            towns: Array.from(xian.towns.values()).map(xiang => ({
                                name: xiang.name,
                                code: xiang.code,
                                villages: xiang.villages
                            }))
                        }))
                    }));
                resolve(result);
            })
            .on('error', (err) => {
                console.error(`  [错误] 读取CSV失败: ${err.message}`);
                resolve(null);
            });
    });
}

async function generateProvinceCache(year, province) {
    console.log(`  生成 ${province} ${year}年 数据...`);
    
    const tree = await loadFullTreeFromCSV(year, province);
    
    if (!tree) {
        return false;
    }

    const filename = `tree_${year}_${province}.json`;
    const filepath = path.join(PROVINCES_DIR, filename);
    
    fs.writeFileSync(filepath, JSON.stringify(tree, null, 2));
    
    const size = (fs.statSync(filepath).size / 1024 / 1024).toFixed(2);
    console.log(`    -> ${filename} (${size} MB)`);
    
    return true;
}

async function main() {
    const args = process.argv.slice(2);
    const years = args.length > 0 ? [args[0]] : YEARS;

    console.log('========================================');
    console.log('省份缓存预生成工具');
    console.log('========================================\n');

    // 确保输出目录存在
    ensureDir(PROVINCES_DIR);

    let totalGenerated = 0;
    let totalFailed = 0;

    for (const year of years) {
        console.log(`\n处理年份: ${year}`);
        console.log('-'.repeat(40));

        // 检查CSV文件是否存在
        const csvPath = getCSVPath(year);
        if (!fs.existsSync(csvPath)) {
            console.log(`[错误] CSV文件不存在: ${csvPath}`);
            continue;
        }

        for (const province of PROVINCES) {
            try {
                const success = await generateProvinceCache(year, province);
                if (success) {
                    totalGenerated++;
                } else {
                    totalFailed++;
                }
            } catch (err) {
                console.error(`  [错误] 处理 ${province} 失败: ${err.message}`);
                totalFailed++;
            }
        }
    }

    console.log('\n========================================');
    console.log('完成!');
    console.log(`成功: ${totalGenerated} 个省份缓存文件`);
    console.log(`失败: ${totalFailed} 个`);
    console.log(`输出目录: ${PROVINCES_DIR}`);
    console.log('========================================\n');

    // 生成索引文件，方便检查
    const index = {
        generated: new Date().toISOString(),
        years: years,
        provinces: PROVINCES.length,
        files: []
    };

    for (const year of years) {
        for (const province of PROVINCES) {
            const filename = `tree_${year}_${province}.json`;
            const filepath = path.join(PROVINCES_DIR, filename);
            if (fs.existsSync(filepath)) {
                const stats = fs.statSync(filepath);
                index.files.push({
                    year,
                    province,
                    filename,
                    size: stats.size,
                    mtime: stats.mtime.toISOString()
                });
            }
        }
    }

    fs.writeFileSync(path.join(PROVINCES_DIR, 'index.json'), JSON.stringify(index, null, 2));
    console.log('索引文件已生成: index.json');
}

main().catch(console.error);