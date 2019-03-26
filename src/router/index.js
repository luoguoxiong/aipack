import AsyncComponent from '../components/AsyncComponent'
const Home = AsyncComponent(() => import('../page/home'))
const Topic = AsyncComponent(() => import('../page/topic'))
const Catelog = AsyncComponent(() => import('../page/catelog'))
const Cart = AsyncComponent(() => import('../page/cart'))
const Mine = AsyncComponent(() => import('../page/mine'))
const Categorys = AsyncComponent(() => import('../page/categorys'))
const Goods = AsyncComponent(() => import('../page/goods'))
const BrandDetail = AsyncComponent(() => import('../page/brandDetail'))
const TopicDetail = AsyncComponent(() => import('../page/topicDetail'))
const Comment = AsyncComponent(() => import('../page/comment'))
const TopicCommentWrite = AsyncComponent(() => import('../page/topicCommentWrite'))
const GoodsSearch = AsyncComponent(() => import('../page/goodsSearch'))
const Collect = AsyncComponent(() => import('../page/collect'))
const Address = AsyncComponent(() => import('../page/address'))
const routes = [
  {
    name: '首页',
    isTab: true,
    link: '/home',
    component: Home
  },
  {
    name: '专题',
    link: '/topic',
    isTab: true,
    component: Topic
  },
  {
    name: '分类',
    link: '/catelog',
    isTab: true,
    component: Catelog
  },
  {
    name: '购物车',
    link: '/cart',
    isTab: true,
    component: Cart
  },
  {
    name: '我的',
    link: '/mine',
    isTab: true,
    component: Mine
  },
  {
    name: '分类商品',
    link: '/categorys/:id',
    isTab: false,
    component: Categorys
  },
  {
    name: '商品详情',
    link: '/goods/:id',
    isTab: false,
    component: Goods
  },
  {
    name: '制造商详情',
    link: '/brandDetail/:id',
    isTab: false,
    component: BrandDetail
  },
  {
    name: '专题详情',
    link: '/topicDetail/:id',
    isTab: false,
    component: TopicDetail
  },
  {
    name: '评论页',
    link: '/comment/:id',
    isTab: false,
    component: Comment
  },
  {
    name: '写专题评论',
    link: '/topicCommentWrite/:id',
    isTab: false,
    component: TopicCommentWrite
  },
  {
    name: '商品查询',
    link: '/GoodsSearch',
    isTab: false,
    component: GoodsSearch
  },
  {
    name: '收藏商品',
    link: '/Collect',
    isTab: false,
    component: Collect
  },
  {
    name: '地址管理',
    link: '/Address',
    isTab: false,
    component: Address
  }
]
export default routes
