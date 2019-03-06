import Home from '../page/home'
import Topic from '../page/topic'
import Catelog from '../page/catelog'
import Cart from '../page/cart'
import Mine from '../page/mine'
import Categorys from '../page/categorys'
import Goods from '../page/goods'
import BrandDetail from '../page/brandDetail'
import TopicDetail from '../page/topicDetail'
import Comment from '../page/comment'
import TopicCommentWrite from '../page/topicCommentWrite'
import GoodsSearch from '../page/goodsSearch'
import Collect from '../page/collect'

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
  }
]
export default routes
