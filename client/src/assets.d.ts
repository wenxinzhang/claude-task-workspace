// 让类型检查认识打包器处理的图片导入：导入得到的是图片的访问地址
declare module '*.png' {
  const src: string;
  export default src;
}
