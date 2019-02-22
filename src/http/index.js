import HttpUtils from './http'
class Https {
  /*
  * 登录
  * parmas:
  *   mobile: 电话号码
  *   password: 密码
  * */
  postLogin = parmas => (HttpUtils.post('/auth/loginByMobile',parmas))

  //获取首页数据
  getHomeData = params => (HttpUtils.get('/', params))

  /*
  *  获取专题数据
  *  parmas:
  *   page: 当前页数
  *   size: 每页数据量
  * */
  getTopicData = parmas => (HttpUtils.get('/topic/list',parmas))

  /*
   * 根据专题Id获取专题详情
   * parmas:
   *   id: 专题id
   * */
  getTopicDetail = parmas => (HttpUtils.get('/topic/detail',parmas))

  /*
   * 根据专题Id获取相关专题
   * parmas:
   *   id: 专题id
   * */
  getTopicDetailRelated = parmas => (HttpUtils.get('/topic/related',parmas))

  /*
   * 根据专题ID或者商品ID获取评论获取相关专题
   * parmas:
   *   valueId: 专题id、商品id
   *  typeId：1:专题id、0:商品id
   *  page:
   *  size:
   * */
  getCommentList = parmas => (HttpUtils.get('/comment/list',parmas))

  /*
  * 获取分类ID分类Nav数据
  * params:
  *   id: 当前分类Id
  * */
  getCategoryNavData = parmas => (HttpUtils.get('/goods/category',parmas))

  /*
  *  根据分类Id或者制造商Id获取商品
  *  parmas:
  *   brandId: 制造商Id（非必填）
  *   categoryId: 分类Id（非必填）
  *   sort: id(默认排序)、price(价格排序)
  *   order: 排序方式
  *   page: 当前页数
  *   size: 每页数据量
  * */
  getGoodsData = parmas => (HttpUtils.get('/goods/list',parmas))

  /*
  * 分类页初始化信息获取
  * */
  getCatalogInitData = parmas => (HttpUtils.get('/catalog/index',parmas))

  /*
  * 根据分类ID获取当前分类信息和子分类
  * parmas:
  *   id: 分类Id
  * */
  getCatalogMsg = parmas => (HttpUtils.get('/catalog/current',parmas))

  /*
  * 获取在售商品数量
  * */
  getSellGoodsCount = parmas => (HttpUtils.get('/goods/count',parmas))

  /*
  * 根据制造商ID获取制造商详情
  * parmas:
  *   id: 制造商Id
  * */
  getBrandDetail = parmas => (HttpUtils.get('/brand/detail',parmas))

  /*
  * 根据制造商ID获取制造商相关商品（同根据分类ID获取商品）
  * parmas:
  *   id: 制造商Id
  *   page: 当前页数
  *   size: 每页数据量
  * */
  getBrandGoods = parmas => (HttpUtils.get('/brand/detail',parmas))

  /*
  * 对某个商品或专题ID进行评论
  * parmas:
  *   content: 内容
  *   typeId: 类型
  *   valueId: id
  * */
  postSetComment = parmas => (HttpUtils.post('/comment/post',parmas))

  /*
  * 获取商品查询的相关信息
  * parmas: {}
  * */
    getGoodsSearchMsg = (parmas = {}) => (HttpUtils.get('/search/index',parmas))

  /*
  * 商品查询模糊查询关键字
  * parmas:
  *  keyword: 查询名称
  * */
  getGoodsSearchKey = (parmas = {}) => (HttpUtils.get('/search/helper',parmas))

  /*
  * 删除商品查询的历史记录
  * parmas: {}
  * */
  getDeleteGoodsSearchHistory = (parmas = {}) => (HttpUtils.get('/search/clearhistory',parmas))

  /*
  * 获取商品详情
  * /api/goods/detail
  * parmas:
  *   id: 商品id
  * */
  getGoodsDetail = (parmas = {}) => (HttpUtils.get('/goods/detail',parmas))

  /*
  * 相关商品
  * /api/goods/related
  * parmas:
  *   id: 商品id
  * */
  getGoodsRelated = (parmas = {}) => (HttpUtils.get('/goods/related',parmas))

  /*
  * 获取用户购物车商品数量
  * /api/cart/goodscount
  * parmas:
  * */
  getCartNum = (parmas = {}) => (HttpUtils.get('/cart/goodscount',parmas))

  /*
  * 登录
  * /api/collect/addordelete
  * parmas:
  *   mobile: 电话号码
  *   password: 密码
  * */
  postDoLikes = parmas => (HttpUtils.post('/collect/addordelete',parmas))

  /*
  * 添加到购物车
  * /api/cart/add
  * parmas:
  *   goodsId: 商品Id
  *   number: 数量
  *   productId: 产品价格ID
  * */
  postAddCart = parmas => (HttpUtils.post('/cart/add',parmas))

  /*
  * 获取用户购物车数据
  * /api/cart/index
  * parmas:
  * */
  getCartData = (parmas = {}) => (HttpUtils.get('/cart/index',parmas))

  /*
  * 购物车商品是否选中
  * /api/cart/checked
  * parmas:
  *   isChecked: 是否选中(1:是，0否)
  *   productIds： 商品产品Id
  * */
  postCartCheck = (parmas = {}) => (HttpUtils.post('/cart/checked',parmas))

  /*
  * 删除购物车商品
  * /api/cart/delete
  * parmas:
  *   productIds： 商品产品Id
  * */
  postCartDelete = (parmas = {}) => (HttpUtils.post('/cart/delete',parmas))

  /*
   * 删除购物车商品
   * /api/cart/update
   * parmas:
   *   productIds： 商品产品Id
   * */
  postCartUpdate = (parmas = {}) => (HttpUtils.post('/cart/update',parmas))

}
export default new Https()
