import { combineReducers } from 'redux';
import home from './home'
import common from './common'
import topic from './topic'
import catrgorys from './categorys'
import catalog from './catalog'
import goods from './goods'
import brand from './brand'
import topicDetail from './topicDetail'
import comment from './comment'
import goodsSearch from './goodsSearch'
import collect from './collect'
const CombineReducers = combineReducers({
  home,
  common,
  topic,
  catrgorys,
  goods,
  catalog,
  brand,
  topicDetail,
  comment,
  goodsSearch,
  collect
})

export default CombineReducers;
