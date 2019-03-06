import { all, fork } from 'redux-saga/effects';
import home from './home';
import topic from './topic';
import categorys from './categorys';
import catalog from './catalog'
import goods from './goods'
import brand from './brand'
import topicDetail from './topicDetail'
import comment from './comment'
import goodsSearch from './goodsSearch'
import collect from './collect'
export default function* root() {
  yield all([
    fork(home),
    fork(topic),
    fork(categorys),
    fork(catalog),
    fork(goods),
    fork(brand),
    fork(topicDetail),
    fork(comment),
    fork(goodsSearch),
    fork(collect)
  ]);
}
