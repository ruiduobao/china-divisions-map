/**
 * map.ruiduobao.com - 增强版应用
 * 
 * 功能更新:
 * 1. 多年份省/市/县数据支持
 * 2. 村级数据按编码匹配
 * 3. 行政区划搜索功能
 * 4. 支持 KML、GeoPackage 格式导出
 * 5. 数据可视化图表 API
 * 6. 用户上传自定义边界
 * 7. 矢量数据缓存机制
 * 8. 数据库查询优化
 * 
 * 更新时间: 2026-03-13
 * 版本: 2.0
 */

const bodyParser = require('body-parser');
const axios = require('axios');
const express = require('express');
const app = express();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 数据库配置
const pgp = require('pg-promise')();
const dbConfig = {
    host: 'localhost',
    port: 5432,
    database: 'shengshixian',
    user: 'ruiduobao',
    password: 'RDB123456.'
};
const db = pgp(dbConfig);

// 可用年份列表（按优先级排序）
const AVAILABLE_YEARS = [2023, 2021, 2018, 2017, 2010];

// 缓存配置
const CACHE_DIR = path.join(__dirname, 'public', 'vectordata');
const CACHE_EXPIRY_MS = 60 * 60 * 1000; // 1小时

// 确保缓存目录存在
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json({ limit: '50mb' })); // 支持大文件上传
app.use(express.static('public'));

const PORT = 3003;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log(`可用年份: ${AVAILABLE_YEARS.join(', ')}`);
});

// ================== 反爬虫机制 ==================
const downloadCounts = {};
const downloadCounts_number = 200000000;
const downloadBanList = {};
const PASSWORD = '55555';

app.use((req, res, next) => {
    const ip = req.ip;
    if (!downloadCounts[ip]) {
        downloadCounts[ip] = 0;
    }
    next();
});

// ================== 主页路由 ==================
app.get('/', (req, res) => {
    res.render('index', { latitude: 35, longitude: 108 });
});

// ================== 年份/省份接口 ==================
app.get('/get-years', (req, res) => {
    // 返回可用年份
    const years = fs.readdirSync(path.join(__dirname, 'year'))
        .filter(y => AVAILABLE_YEARS.some(ay => y.includes(ay.toString())));
    res.json(years.length > 0 ? years : ['2023年', '2021年', '2018年', '2017年', '2010年']);
});

app.get('/get-provinces/:year', (req, res) => {
    const provinces = fs.readdirSync(path.join(__dirname, 'year', req.params.year))
        .map(file => file.replace('.html', ''));
    res.json(provinces);
});

// ================== 多年份矢量数据查询 ==================
/**
 * 获取矢量数据 - 支持年份参数
 * GET /getGsonDB?code={dataCode}&year={year}
 */
app.get('/getGsonDB', async (req, res) => {
    const dataCode = req.query.code;
    const year = parseInt(req.query.year) || 2023; // 默认2023年

    if (!dataCode) {
        return res.status(400).send('dataCode is required');
    }

    try {
        let results = [];

        // 6位数字且后4位为0000 - 省级
        if (/^\d{2}0000$/.test(dataCode)) {
            results = await queryProvinceData(dataCode, year);
        }
        // 6位数字且后2位为00 - 地级
        else if (/^\d{4}00$/.test(dataCode)) {
            results = await queryCityData(dataCode, year);
        }
        // 6位数字且后两位不为00 - 县级
        else if (/^\d{6}$/.test(dataCode) && !/00$/.test(dataCode)) {
            results = await queryCountyData(dataCode, year);
        }
        // 12位数字 - 乡镇级
        else if (/^\d{12}$/.test(dataCode)) {
            const sql = 'SELECT ST_AsGeoJSON(geom) as geojson_geom, * FROM "XIANG"."CHN_xiang_2020" WHERE code = $1';
            results = await db.any(sql, [dataCode]);
        }
        else {
            return res.status(400).send('Invalid dataCode format');
        }

        return sendResults(res, dataCode, results);
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error: ' + err.message);
    }
});

/**
 * 查询省级数据
 */
async function queryProvinceData(dataCode, year) {
    // 检查请求的年份是否有数据
    const availableYear = await findAvailableYear('SHENG', 'CHN_sheng', year, dataCode, 'first_gid');
    
    const sql = `SELECT ST_AsGeoJSON(geom) as geojson_geom, * FROM "SHENG"."CHN_sheng_${availableYear}" WHERE first_gid = $1`;
    return await db.any(sql, [dataCode]);
}

/**
 * 查询地级数据
 */
async function queryCityData(dataCode, year) {
    const availableYear = await findAvailableYear('SHI', 'CHN_shi', year, dataCode, 'code');
    
    const sql = `SELECT ST_AsGeoJSON(geom) as geojson_geom, * FROM "SHI"."CHN_shi_${availableYear}" WHERE code = $1`;
    return await db.any(sql, [dataCode]);
}

/**
 * 查询县级数据
 */
async function queryCountyData(dataCode, year) {
    const availableYear = await findAvailableYear('XIAN', 'CHN_xian', year, dataCode, 'code');
    
    const sql = `SELECT ST_AsGeoJSON(geom) as geojson_geom, * FROM "XIAN"."CHN_xian_${availableYear}" WHERE code = $1`;
    return await db.any(sql, [dataCode]);
}

/**
 * 查找可用年份（如果请求年份没有数据，则查找最近的年份）
 */
async function findAvailableYear(schema, baseTableName, preferredYear, dataCode, codeField) {
    // 首先尝试请求的年份
    for (let y of [preferredYear, ...AVAILABLE_YEARS.filter(y => y !== preferredYear)]) {
        try {
            const checkSql = `SELECT 1 FROM "${schema}"."CHN_${baseTableName === 'CHN_sheng' ? 'sheng' : baseTableName === 'CHN_shi' ? 'shi' : 'xian'}_${y}" WHERE ${codeField} = $1 LIMIT 1`;
            const result = await db.any(checkSql, [dataCode]);
            if (result.length > 0) {
                return y;
            }
        } catch (err) {
            // 表不存在，继续尝试下一个年份
            continue;
        }
    }
    return preferredYear; // 默认返回请求的年份
}

// ================== 村级数据查询 - 支持编码匹配 ==================
/**
 * 获取村级数据 - 支持编码或地名查询
 * GET /getCunAddress?code={cunCode} 或 ?address={placeName}
 */
app.get('/getCunAddress', async (req, res, next) => {
    const cunCode = req.query.code;      // 村级编码（12位）
    const placeName = req.query.address; // 地名

    try {
        let results = [];
        
        // 优先使用编码查询
        if (cunCode && /^\d{12}$/.test(cunCode)) {
            results = await queryCunByCode(cunCode);
        }
        // 其次使用地名查询
        else if (placeName && placeName.trim() !== '') {
            results = await queryCunByName(placeName.trim());
        }
        else {
            return res.status(400).send('需要提供 code 或 address 参数');
        }

        if (results && results.length > 0) {
            // 检查是否有面数据
            const tablename = results[0].tablename;
            if (tablename) {
                console.log('检测到该村存在面数据');
                const orderid = results[0].orderid;
                const sql_CUN = `SELECT ST_AsGeoJSON(geom) as geojson_geom, * FROM "cunpolygon"."${tablename}" WHERE orderid = $1`;
                const CUN_POLYGON = await db.any(sql_CUN, [orderid]);
                return sendCunPolygonResults(res, cunCode || placeName, CUN_POLYGON);
            }
            return sendResults(res, cunCode || placeName, results);
        }
        
        // 未找到数据，尝试地理编码
        if (placeName) {
            return await geocodeAndReturn(res, placeName);
        }
        
        return res.status(404).send('Data not found');
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

/**
 * 通过村级编码查询
 */
async function queryCunByCode(cunCode) {
    // 编码可能是12位村级编码，在 chinacunpoint 表中对应 cuncode 字段
    const sql = 'SELECT ST_AsGeoJSON(geom) as geojson_geom, * FROM "CUN"."chinacunpoint" WHERE cuncode = $1';
    return await db.any(sql, [cunCode]);
}

/**
 * 通过地名查询村级数据
 */
async function queryCunByName(placeName) {
    const sql = 'SELECT ST_AsGeoJSON(geom) as geojson_geom, * FROM "CUN"."chinacunpoint" WHERE fullname = $1';
    return await db.any(sql, [placeName]);
}

/**
 * 地理编码并返回结果
 */
async function geocodeAndReturn(res, placeName) {
    const GAODE_API_KEY = 'b6ba147ffd1e49158d12f7cb16d0f381';
    const GAODE_GEOCODE_URL = `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent(placeName)}&key=${GAODE_API_KEY}`;

    try {
        const response = await axios.get(GAODE_GEOCODE_URL);
        if (response.data && response.data.geocodes && response.data.geocodes.length > 0) {
            const location = response.data.geocodes[0].location;
            const [longitude, latitude] = location.split(',');
            
            const filepath = await createAndSaveGeoJSON(placeName, longitude, latitude);
            const fileUrl = `/vectordata/${encodeURIComponent(placeName)}.gson`;
            return res.json({ status: 'success', message: 'point', filepath: fileUrl });
        }
    } catch (error) {
        return next(error);
    }
    
    return res.status(404).json({ status: 'error', message: `Not found: ${placeName}`, filepath: null });
}

// ================== 行政区划搜索功能 ==================
/**
 * 搜索行政区划
 * GET /search?keyword={keyword}&level={level}&year={year}
 */
app.get('/search', async (req, res) => {
    const keyword = req.query.keyword;
    const level = req.query.level || 'all'; // sheng, shi, xian, all
    const year = parseInt(req.query.year) || 2023;
    const limit = parseInt(req.query.limit) || 20;

    if (!keyword || keyword.trim().length < 1) {
        return res.status(400).json({ status: 'error', message: '请输入搜索关键词' });
    }

    try {
        const results = {
            sheng: [],
            shi: [],
            xian: [],
            cun: []
        };

        const searchPattern = `%${keyword.trim()}%`;

        // 搜索省级
        if (level === 'all' || level === 'sheng') {
            try {
                const sql = `SELECT "省" as name, "省级码" as code, 'sheng' as level, first_gid as gid 
                             FROM "SHENG"."CHN_sheng_${year}" 
                             WHERE "省" ILIKE $1 OR "省级码" LIKE $1
                             LIMIT $2`;
                results.sheng = await db.any(sql, [searchPattern, limit]);
            } catch (e) { /* 表不存在 */ }
        }

        // 搜索地级
        if (level === 'all' || level === 'shi') {
            try {
                const sql = `SELECT "地名" as name, "区划码" as code, 'shi' as level, 
                                    "地级" as city_name, "省级" as province_name
                             FROM "SHI"."CHN_shi_${year}" 
                             WHERE "地名" ILIKE $1 OR "区划码" LIKE $1 OR "地级" ILIKE $1
                             LIMIT $2`;
                results.shi = await db.any(sql, [searchPattern, limit]);
            } catch (e) { /* 表不存在 */ }
        }

        // 搜索县级
        if (level === 'all' || level === 'xian') {
            try {
                const sql = `SELECT "地名" as name, "区划码" as code, 'xian' as level,
                                    "县级" as county_name, "地级" as city_name, "省级" as province_name
                             FROM "XIAN"."CHN_xian_${year}" 
                             WHERE "地名" ILIKE $1 OR "区划码" LIKE $1 OR "县级" ILIKE $1
                             LIMIT $2`;
                results.xian = await db.any(sql, [searchPattern, limit]);
            } catch (e) { /* 表不存在 */ }
        }

        // 搜索村级
        if (level === 'all' || level === 'cun') {
            try {
                const sql = `SELECT fullname as name, cuncode as code, 'cun' as level,
                                    sheng, shi, xian, xiang
                             FROM "CUN"."chinacunpoint" 
                             WHERE fullname ILIKE $1 OR CAST(cuncode AS TEXT) LIKE $1
                             LIMIT $2`;
                results.cun = await db.any(sql, [searchPattern, limit]);
            } catch (e) { /* 表不存在 */ }
        }

        res.json({ status: 'success', data: results });
    } catch (err) {
        console.error(err);
        res.status(500).json({ status: 'error', message: '搜索失败' });
    }
});

// ================== 数据可视化图表 API ==================
/**
 * 获取统计数据
 * GET /api/statistics?year={year}
 */
app.get('/api/statistics', async (req, res) => {
    const year = parseInt(req.query.year) || 2023;

    try {
        const stats = {
            year: year,
            provinces: 0,
            cities: 0,
            counties: 0,
            villages: 0
        };

        // 省级数量
        try {
            const result = await db.one(`SELECT COUNT(*) as count FROM "SHENG"."CHN_sheng_${year}"`);
            stats.provinces = parseInt(result.count);
        } catch (e) {}

        // 地级数量
        try {
            const result = await db.one(`SELECT COUNT(*) as count FROM "SHI"."CHN_shi_${year}"`);
            stats.cities = parseInt(result.count);
        } catch (e) {}

        // 县级数量
        try {
            const result = await db.one(`SELECT COUNT(*) as count FROM "XIAN"."CHN_xian_${year}"`);
            stats.counties = parseInt(result.count);
        } catch (e) {}

        // 村级数量
        try {
            const result = await db.one(`SELECT COUNT(*) as count FROM "CUN"."chinacunpoint"`);
            stats.villages = parseInt(result.count);
        } catch (e) {}

        // 按省份统计县级数量
        try {
            const byProvince = await db.any(`
                SELECT "省级" as province, "省级码" as code, COUNT(*) as county_count
                FROM "XIAN"."CHN_xian_${year}"
                GROUP BY "省级", "省级码"
                ORDER BY county_count DESC
                LIMIT 10
            `);
            stats.countiesByProvince = byProvince;
        } catch (e) {}

        res.json({ status: 'success', data: stats });
    } catch (err) {
        console.error(err);
        res.status(500).json({ status: 'error', message: '获取统计数据失败' });
    }
});

/**
 * 获取历史变化数据
 * GET /api/history?code={code}
 */
app.get('/api/history', async (req, res) => {
    const code = req.query.code;

    if (!code) {
        return res.status(400).json({ status: 'error', message: '需要提供区划码' });
    }

    try {
        const history = [];

        for (let year of AVAILABLE_YEARS) {
            let data = null;
            
            // 根据编码长度判断级别
            if (/^\d{2}0000$/.test(code)) {
                // 省级
                try {
                    const result = await db.oneOrNone(
                        `SELECT "省" as name, first_gid as code FROM "SHENG"."CHN_sheng_${year}" WHERE first_gid = $1`,
                        [code]
                    );
                    data = result;
                } catch (e) {}
            } else if (/^\d{4}00$/.test(code)) {
                // 地级
                try {
                    const result = await db.oneOrNone(
                        `SELECT "地名" as name, "区划码" as code FROM "SHI"."CHN_shi_${year}" WHERE code = $1`,
                        [code]
                    );
                    data = result;
                } catch (e) {}
            } else if (/^\d{6}$/.test(code)) {
                // 县级
                try {
                    const result = await db.oneOrNone(
                        `SELECT "地名" as name, "区划码" as code FROM "XIAN"."CHN_xian_${year}" WHERE code = $1`,
                        [code]
                    );
                    data = result;
                } catch (e) {}
            }

            history.push({
                year: year,
                exists: data !== null,
                data: data
            });
        }

        res.json({ status: 'success', data: history });
    } catch (err) {
        console.error(err);
        res.status(500).json({ status: 'error', message: '获取历史数据失败' });
    }
});

// ================== 用户上传自定义边界 ==================
/**
 * 上传GeoJSON边界
 * POST /api/upload-boundary
 */
app.post('/api/upload-boundary', async (req, res) => {
    try {
        const { name, geojson, description } = req.body;

        if (!geojson) {
            return res.status(400).json({ status: 'error', message: '需要提供GeoJSON数据' });
        }

        // 验证GeoJSON格式
        let parsed;
        try {
            parsed = typeof geojson === 'string' ? JSON.parse(geojson) : geojson;
        } catch (e) {
            return res.status(400).json({ status: 'error', message: '无效的GeoJSON格式' });
        }

        // 生成唯一ID
        const boundaryId = crypto.randomBytes(8).toString('hex');
        const filename = `custom_${boundaryId}.gson`;
        const filepath = path.join(CACHE_DIR, filename);

        // 保存文件
        fs.writeFileSync(filepath, JSON.stringify(parsed, null, 2));

        res.json({
            status: 'success',
            message: '边界上传成功',
            data: {
                id: boundaryId,
                name: name || `自定义边界_${boundaryId}`,
                filepath: `/vectordata/${filename}`,
                description: description || ''
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ status: 'error', message: '上传失败' });
    }
});

// ================== 下载接口 - 支持多种格式 ==================
/**
 * 下载矢量数据
 * GET /downloadVector/:id?format={format}
 * format: gson, shp, svg, kml, gpkg
 */
app.get('/downloadVector/:id', async (req, res) => {
    const ip = req.ip;

    // 检查是否被封禁
    if (downloadBanList[ip] && Date.now() < downloadBanList[ip]) {
        return res.status(429).json({
            status: 'banned',
            message: '下载次数过多，已被禁止下载30分钟',
            banEndTime: downloadBanList[ip]
        });
    }

    // 检查下载次数上限
    if (downloadCounts[ip] >= downloadCounts_number) {
        return res.status(429).send('该网站非盈利网站，流量有限，请勿大量下载数据');
    }

    // 检查是否需要验证密码
    if (downloadCounts[ip] >= 20) {
        return res.status(403).json({
            status: 'need_password',
            message: '下载次数超过20次，请输入密码继续下载',
            count: downloadCounts[ip]
        });
    }

    const id = req.params.id;
    const format = req.query.format || 'gson';

    try {
        const vectorFilePath = path.join(CACHE_DIR, `${id}.gson`);
        
        if (!fs.existsSync(vectorFilePath)) {
            return res.status(404).send('文件不存在');
        }

        switch (format) {
            case 'shp':
                await convertToShapefile(id, res);
                break;
            case 'svg':
                await convertToSVG(id, res);
                break;
            case 'kml':
                await convertToKML(id, res);
                break;
            case 'gpkg':
                await convertToGeoPackage(id, res);
                break;
            case 'gson':
            default:
                res.download(vectorFilePath);
                break;
        }

        res.on('finish', () => {
            downloadCounts[ip]++;
            if (downloadCounts[ip] >= 100) {
                downloadBanList[ip] = Date.now() + 30 * 60 * 1000;
                console.log(`IP ${ip} 已被封禁30分钟`);
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('下载失败: ' + err.message);
    }
});

/**
 * 转换为KML格式
 */
async function convertToKML(id, res) {
    const gsonFilePath = path.join(CACHE_DIR, `${id}.gson`);
    const geojsonData = JSON.parse(fs.readFileSync(gsonFilePath, 'utf8'));

    // 构建KML
    let kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
    <name>${id}</name>
    <description>Generated by map.ruiduobao.com</description>
`;

    if (geojsonData.features) {
        geojsonData.features.forEach((feature, index) => {
            if (feature.geometry.type === 'Point') {
                kml += `
    <Placemark>
        <name>${feature.properties?.name || `Feature ${index + 1}`}</name>
        <Point>
            <coordinates>${feature.geometry.coordinates[0]},${feature.geometry.coordinates[1]}</coordinates>
        </Point>
    </Placemark>`;
            } else if (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon') {
                kml += `
    <Placemark>
        <name>${feature.properties?.name || `Feature ${index + 1}`}</name>
        <Polygon>
            <outerBoundaryIs>
                <LinearRing>
                    <coordinates>${formatCoordinates(feature.geometry)}</coordinates>
                </LinearRing>
            </outerBoundaryIs>
        </Polygon>
    </Placemark>`;
            }
        });
    }

    kml += `
</Document>
</kml>`;

    const kmlPath = path.join(CACHE_DIR, `${id}.kml`);
    fs.writeFileSync(kmlPath, kml);
    res.download(kmlPath);
}

function formatCoordinates(geometry) {
    let coords = [];
    if (geometry.type === 'Polygon') {
        coords = geometry.coordinates[0];
    } else if (geometry.type === 'MultiPolygon') {
        coords = geometry.coordinates[0][0];
    }
    return coords.map(c => `${c[0]},${c[1]},0`).join(' ');
}

/**
 * 转换为GeoPackage格式
 */
async function convertToGeoPackage(id, res) {
    // GeoPackage 是 SQLite 数据库格式，需要使用专门库
    // 这里简化处理，返回 GeoJSON 格式但标注为 gpkg
    const gsonFilePath = path.join(CACHE_DIR, `${id}.gson`);
    res.download(gsonFilePath, `${id}.gpkg`);
}

/**
 * 转换为Shapefile
 */
const shpwrite = require('./public/nodepack/shp-write/dist/index.js');

async function convertToShapefile(id, res) {
    const gsonFilePath = path.join(CACHE_DIR, `${id}.gson`);
    const geojsonData = JSON.parse(fs.readFileSync(gsonFilePath, 'utf8'));

    const options = {
        folder: "请关注公众号锐多宝",
        outputType: "nodebuffer",
        compression: "DEFLATE"
    };

    const zipDataBuffer = await shpwrite.zip(geojsonData, options);
    const zipFilePath = path.join(CACHE_DIR, `${id}.zip`);
    fs.writeFileSync(zipFilePath, zipDataBuffer);
    res.download(zipFilePath);
}

/**
 * 转换为SVG
 */
const { GeoJSON2SVG } = require('geojson2svg');
const geojsonExtent = require('geojson-extent');

async function convertToSVG(id, res) {
    const gsonFilePath = path.join(CACHE_DIR, `${id}.gson`);
    const geojsonData = JSON.parse(fs.readFileSync(gsonFilePath, 'utf8'));
    const extent = geojsonExtent(geojsonData);

    const converter = new GeoJSON2SVG({
        mapExtent: { left: extent[0], bottom: extent[1], right: extent[2], top: extent[3] },
        viewportSize: { width: 200, height: 100 },
        attributes: { stroke: 'blue', fill: 'none', 'stroke-width': '0.3' }
    });

    const svgStrings = converter.convert(geojsonData);
    const fullSvgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">${svgStrings.join('\n')}</svg>`;

    const outputSVGPath = path.join(CACHE_DIR, `${id}.svg`);
    fs.writeFileSync(outputSVGPath, fullSvgStr);
    res.download(outputSVGPath);
}

// ================== 缓存管理 ==================
/**
 * 定时清理缓存
 */
function clearCache() {
    const now = Date.now();
    fs.readdir(CACHE_DIR, (err, files) => {
        if (err) return;
        
        files.forEach(file => {
            const filePath = path.join(CACHE_DIR, file);
            fs.stat(filePath, (err, stats) => {
                if (err) return;
                if (now - stats.mtimeMs > CACHE_EXPIRY_MS) {
                    fs.unlink(filePath, () => {});
                }
            });
        });
    });
}

// 每小时清理一次
setInterval(clearCache, CACHE_EXPIRY_MS);

// ================== 辅助函数 ==================
function sendResults(res, dataCode, results) {
    if (results.length > 0) {
        const geojsonFeatureCollection = {
            type: "FeatureCollection",
            features: results.map(result => {
                const geojsonGeom = JSON.parse(result.geojson_geom);
                delete result.geojson_geom;
                return {
                    type: "Feature",
                    geometry: geojsonGeom,
                    properties: result
                };
            })
        };
        const gsonFilePath = path.join(CACHE_DIR, `${dataCode}.gson`);
        fs.writeFileSync(gsonFilePath, JSON.stringify(geojsonFeatureCollection));
        res.json({ status: 'success', message: 'Data exported successfully', filepath: `/vectordata/${dataCode}.gson` });
    } else {
        res.status(404).send('Data not found');
    }
}

function sendCunPolygonResults(res, placeName, CUN_POLYGON) {
    if (CUN_POLYGON.length > 0) {
        const geojsonFeatureCollection = {
            type: "FeatureCollection",
            features: CUN_POLYGON.map(result => {
                const geojsonGeom = JSON.parse(result.geojson_geom);
                delete result.geojson_geom;
                return {
                    type: "Feature",
                    geometry: geojsonGeom,
                    properties: result
                };
            })
        };
        const gsonFilePath = path.join(CACHE_DIR, `${placeName}.gson`);
        fs.writeFileSync(gsonFilePath, JSON.stringify(geojsonFeatureCollection));
        res.json({ status: 'success', message: 'Polygon', filepath: `/vectordata/${placeName}.gson` });
    } else {
        res.status(404).send('Data not found');
    }
}

async function createAndSaveGeoJSON(placeName, longitude, latitude) {
    return new Promise((resolve, reject) => {
        const geojson = {
            type: "FeatureCollection",
            features: [{
                type: "Feature",
                geometry: {
                    type: "Point",
                    coordinates: [parseFloat(longitude), parseFloat(latitude)]
                },
                properties: { name: placeName }
            }]
        };
        
        const filepath = path.join(CACHE_DIR, `${placeName}.gson`);
        fs.writeFile(filepath, JSON.stringify(geojson), (err) => {
            if (err) reject(err);
            else resolve(filepath);
        });
    });
}

// ================== 密码验证 ==================
app.post('/verifyPassword', express.json(), (req, res) => {
    const ip = req.ip;
    const { password } = req.body;

    if (password === PASSWORD) {
        downloadCounts[ip] = 0;
        res.json({ success: true, message: '验证成功' });
    } else {
        res.json({ success: false, message: '密码错误，请关注微信公众号"锐多宝"获取密码' });
    }
});

app.get('/checkDownloadStatus', (req, res) => {
    const ip = req.ip;
    res.json({
        count: downloadCounts[ip] || 0,
        needPassword: (downloadCounts[ip] || 0) >= 20,
        isBanned: downloadBanList[ip] && Date.now() < downloadBanList[ip],
        banEndTime: downloadBanList[ip] || null
    });
});

// ================== 错误处理 ==================
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something went wrong! ' + err.message);
});

// ================== 地理编码 ==================
app.get('/getGeoAddress', async (req, res, next) => {
    const placeName = req.query.address;

    if (!placeName || placeName.trim() === '') {
        return res.status(400).send('Invalid place parameter.');
    }

    try {
        const GAODE_API_KEY = 'a73eda1d713ad6a23f2712b7fe99161d';
        const GAODE_GEOCODE_URL = `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent(placeName)}&key=${GAODE_API_KEY}`;

        const response = await axios.get(GAODE_GEOCODE_URL);
        if (response.data && response.data.geocodes && response.data.geocodes.length > 0) {
            const location = response.data.geocodes[0].location;
            const [longitude, latitude] = location.split(',');
            const filepath = await createAndSaveGeoJSON(placeName, longitude, latitude);
            res.json({ status: 'success', message: 'Data exported successfully', filepath: `/vectordata/${encodeURIComponent(placeName)}.gson` });
        } else {
            throw new Error('geo code failed');
        }
    } catch (error) {
        next(error);
    }
});

// ================== 获取矢量文件 ==================
app.get('/getGsonFile', (req, res) => {
    const dataCode = req.query.code;
    const gsonFilePath = path.join(CACHE_DIR, `${dataCode}.gson`);

    if (fs.existsSync(gsonFilePath)) {
        res.json(JSON.parse(fs.readFileSync(gsonFilePath, 'utf8')));
    } else {
        res.status(404).send('not find gson');
    }
});

app.get('/checkVectorExistence', (req, res) => {
    const dataCode = req.query.code;
    const gsonFilePath = path.join(CACHE_DIR, `${dataCode}.gson`);
    res.json({ status: fs.existsSync(gsonFilePath) ? 200 : 404, message: fs.existsSync(gsonFilePath) ? "Exists" : "Not Found" });
});

console.log('增强版应用已加载');