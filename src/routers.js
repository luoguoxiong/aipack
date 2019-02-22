import Home from './components/home'
import Topic from './components/topic'
import Catelog from './components/catelog'
import Cart from './components/cart'
import Mine from './components/mine'
import Categorys from './components/categorys'
import Goods from './components/goods'
import BrandDetail from './components/brandDetail'
import TopicDetail from './components/topicDetail'
import Comment from './components/comment'
import TopicCommentWrite from './components/topicCommentWrite'
import GoodsSearch from './components/goodsSearch'

const routers = [
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
  }
]
export default routers