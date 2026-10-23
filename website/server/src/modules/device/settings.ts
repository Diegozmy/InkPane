/**
 * 设备身份设置已迁移到 modules/devices。
 *
 * 旧版单例 device.token / device.name 在 v4 迁移中转入 devices 表；
 * 这里保留文件以避免历史导入路径断裂，不再导出业务函数。
 */
export {};
