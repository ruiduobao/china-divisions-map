#!/bin/bash
# 导入多年份省市县数据脚本
# 作者: OpenClaw
# 日期: 2026-03-13

set -e

DB_HOST="localhost"
DB_PORT="5432"
DB_NAME="shengshixian"
DB_USER="ruiduobao"
DB_PASS="RDB123456."

BASE_DIR="/opt/1panel/apps/openresty/openresty/www/wwwroot/map.ruiduobao.com/处理脚本/data/省市县"

export PGPASSWORD="$DB_PASS"

echo "=========================================="
echo "开始导入多年份省市县数据"
echo "=========================================="

# 函数：导入省级数据
import_sheng() {
    local year=$1
    local shp_file="$BASE_DIR/$year/省级/T${year}年初省级.shp"
    local table_name="CHN_sheng_$year"
    
    if [ ! -f "$shp_file" ]; then
        echo "警告: 文件不存在 $shp_file"
        return 1
    fi
    
    echo "导入省级数据: $year"
    
    # 检查表是否存在
    table_exists=$(psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -tAc \
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'SHENG' AND table_name = '$table_name');")
    
    if [ "$table_exists" = "t" ]; then
        local count=$(psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -tAc \
            "SELECT COUNT(*) FROM \"SHENG\".\"$table_name\";")
        if [ "$count" -gt 0 ]; then
            echo "  表 SHENG.$table_name 已存在且有数据 ($count 条)，跳过"
            return 0
        fi
    fi
    
    # 创建表并导入数据
    shp2pgsql -s 4326 -I -W UTF-8 "$shp_file" "SHENG.$table_name" | \
        psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -q
    
    echo "  完成: SHENG.$table_name"
}

# 函数：导入地级数据
import_shi() {
    local year=$1
    local shp_file="$BASE_DIR/$year/地级/T${year}年初地级.shp"
    local table_name="CHN_shi_$year"
    
    if [ ! -f "$shp_file" ]; then
        echo "警告: 文件不存在 $shp_file"
        return 1
    fi
    
    echo "导入地级数据: $year"
    
    # 检查表是否存在且有数据
    table_exists=$(psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -tAc \
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'SHI' AND table_name = '$table_name');")
    
    if [ "$table_exists" = "t" ]; then
        local count=$(psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -tAc \
            "SELECT COUNT(*) FROM \"SHI\".\"$table_name\";")
        if [ "$count" -gt 0 ]; then
            echo "  表 SHI.$table_name 已存在且有数据 ($count 条)，跳过"
            return 0
        fi
        # 表存在但为空，删除重建
        psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c "DROP TABLE IF EXISTS \"SHI\".\"$table_name\";"
    fi
    
    shp2pgsql -s 4326 -I -W UTF-8 "$shp_file" "SHI.$table_name" | \
        psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -q
    
    echo "  完成: SHI.$table_name"
}

# 函数：导入县级数据
import_xian() {
    local year=$1
    local shp_file="$BASE_DIR/$year/县级/T${year}年初县级.shp"
    local table_name="CHN_xian_$year"
    
    if [ ! -f "$shp_file" ]; then
        echo "警告: 文件不存在 $shp_file"
        return 1
    fi
    
    echo "导入县级数据: $year"
    
    # 检查表是否存在
    table_exists=$(psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -tAc \
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'XIAN' AND table_name = '$table_name');")
    
    if [ "$table_exists" = "t" ]; then
        local count=$(psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -tAc \
            "SELECT COUNT(*) FROM \"XIAN\".\"$table_name\";")
        if [ "$count" -gt 0 ]; then
            echo "  表 XIAN.$table_name 已存在且有数据 ($count 条)，跳过"
            return 0
        fi
        psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c "DROP TABLE IF EXISTS \"XIAN\".\"$table_name\";"
    fi
    
    # 检查坐标系，如果是3857需要转换
    srid=$(ogrinfo -al "$shp_file" 2>/dev/null | grep -oP 'ID\["EPSG",\K\d+')
    
    if [ "$srid" = "3857" ]; then
        echo "  检测到 Pseudo-Mercator 坐标系，转换为 WGS84..."
        shp2pgsql -s 3857:4326 -I -W UTF-8 "$shp_file" "XIAN.$table_name" | \
            psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -q
    else
        shp2pgsql -s 4326 -I -W UTF-8 "$shp_file" "XIAN.$table_name" | \
            psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -q
    fi
    
    echo "  完成: XIAN.$table_name"
}

# 导入各年份数据
YEARS="2010 2017 2018 2021 2023"

for year in $YEARS; do
    echo ""
    echo "--- 处理 $year 年数据 ---"
    import_sheng "$year" || true
    import_shi "$year" || true
    import_xian "$year" || true
done

echo ""
echo "=========================================="
echo "数据导入完成"
echo "=========================================="

# 显示导入结果
echo ""
echo "数据库表统计:"
echo "省级表:"
psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c "SELECT table_name, (SELECT COUNT(*) FROM \"SHENG\".\"" || table_name || "\") as count FROM information_schema.tables WHERE table_schema = 'SHENG' ORDER BY table_name;"

echo ""
echo "地级表:"
psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c "SELECT table_name, (xpath('/row/cnt/text()', xml_count))[1]::text::int as count FROM (SELECT table_name, query_to_xml('SELECT COUNT(*) as cnt FROM \"SHI\".\"' || table_name || '\"', false, true, '') as xml_count FROM information_schema.tables WHERE table_schema = 'SHI') t ORDER BY table_name;"

echo ""
echo "县级表:"
psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'XIAN' ORDER BY table_name;"