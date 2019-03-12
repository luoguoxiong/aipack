import React, {Component} from 'react'
import './index.scss'
import {withRouter} from 'react-router-dom'
import Header from '../../components/header'
import TouchClear from '../../components/touchClear'
// import { Button, Toast } from 'antd-mobile'
import { connect } from 'react-redux';
import { bindActionCreators } from 'redux';
import * as CollectAction from '../../redux/actions/collect';
import * as commonAction from '../../redux/actions/common';
import http from '../../http'
class Collect extends Component{
  state ={
    datas: [{isClose: true},{isClose: true},{isClose: true}]
  }
  goBack () {
    this.props.history.go(-1)
  }
  async componentWillMount() {
    const {fetchData} = this.props.actions
    fetchData()
  }
  toColse (item) {
    const collect = new Array(...this.props.collect)
    collect.forEach((item) => {
      item.isClose = true
    })
    const {apdateData} = this.props.actions
    apdateData(collect)
  }
  toOpen (item) {
    const collect = new Array(...this.props.collect)
    collect.forEach((item) => {
      item.isClose = true
    })
    collect[item].isClose = false
    const {apdateData} = this.props.actions
    apdateData(collect)
  }
  async clickRemove (index, item) {
    this.props.actions1.startLoading()
    await http.postDoLikes({valueId: item.value_id, typeId: 0})
    this.props.actions1.endLoading()
    const collect = new Array(...this.props.collect)
    collect.splice(index,1)
    const {apdateData} = this.props.actions
    apdateData(collect)
  }
  toGoods (item) {
    this.props.history.push(`/goods/${item.value_id}`)
  }
  render () {
    const {collect} = this.props
    return (
      <div id="collect">
        <Header clickLeft={this.goBack.bind(this)} title="easyLikeGoods"/>
        <div className="collectList">
          {
            collect.map((item, index) => (
              <TouchClear key={index}  clickRemove={this.clickRemove.bind(this,index, item)}
                          isClose={item.isClose}
                          toOpen={this.toOpen.bind(this, index)}
                          toClose={this.toColse.bind(this, index)}>
                <div key={item.id} className="collectItem onePx_bottom" onClick={this.toGoods.bind(this,item)}>
                  <img src={item.list_pic_url} alt={item.name} className="collectImg"/>
                  <div className="collectMsg">
                    <div>{item.name}</div>
                    <div>{item.goods_brief}</div>
                    <div>￥{item.retail_price}</div>
                  </div>
                </div>
              </TouchClear>
            ))
          }
        </div>
      </div>
    )
  }
}

const mapStateToProps = (state, props) => ({...state.collect})
const mapDispatchToProps = dispatch => ({
  actions: bindActionCreators(CollectAction, dispatch),
  actions1: bindActionCreators(commonAction, dispatch)
})
export default withRouter(connect(mapStateToProps, mapDispatchToProps)(Collect))
