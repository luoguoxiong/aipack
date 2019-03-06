import React, {Component ,Fragment} from 'react'
import './index.scss'
import http from '../../http'
import isCheck from '../../static/img/isCheck.png'
import noCheck from '../../static/img/noCheck.png'
import noGoods from '../../static/img/noGoods.png'
import { connect } from 'react-redux';
import { bindActionCreators } from 'redux';
import * as commonAction from '../../redux/actions/common';
import {withRouter} from "react-router-dom";
import {Toast} from 'antd-mobile'
class Cart extends Component{
    state = {
        goodsCount: 0,
        checkedGoodsAmount: 0,
        checkedGoodsCount: 0,
        cartList: [],
        isEdit: false
    }
    componentWillMount() {
        this.fetchCartData()
    }
    /*获取购物车商品*/
    async fetchCartData () {
        const {actions:{startLoading, endLoading}} = this.props
        try {
            startLoading()
            const {errno, errmsg, cartList, cartTotal} = await http.getCartData({})
            endLoading()
            if(errno === 401){
                Toast.fail(errmsg, .5,() => {
                    this.props.actions.loginFailure()
                })
            }else{
                const {checkedGoodsAmount, goodsCount, checkedGoodsCount} = cartTotal
                cartList.forEach((item) => {
                    item.isHasEdit = false
                })
                this.setState({
                    cartList,
                    checkedGoodsAmount,
                    goodsCount,
                    checkedGoodsCount
                })
            }
        }catch (e) {
            endLoading()
            throw e
        }
    }
    /*购物车商品切换选中状态*/
    async checkCartGoods (item) {
        const {actions:{startLoading, endLoading}} = this.props
        try {
            startLoading()
            const {errno, errmsg, data} = await http.postCartCheck({isChecked: item.checked===1?0:1, productIds: item.product_id})
            if(errno === 401){
                Toast.fail(errmsg, .5,() => {
                    this.props.actions.loginFailure()
                })
            }else{
                const { cartList, cartTotal: {checkedGoodsAmount, goodsCount, checkedGoodsCount}} = data
                cartList.forEach((item) => {
                    item.isHasEdit = false
                })
                this.setState({
                    cartList,
                    checkedGoodsAmount,
                    goodsCount,
                    checkedGoodsCount
                })
            }
            endLoading()
        }catch (e) {
            endLoading()
            throw e
        }
    }
    /*购物车商品编辑状态*/
    changeEdit (status, cartList) {
        cartList.forEach((item) => {
            item.isHasEdit = false
        })
        this.setState({
            isEdit: !status,
            cartList
        })
    }
    /*购物车商品数量修改*/
    async addOrDelete (item, type, cartList) {
        const {goods_id, id, number, product_id} = item
        if(number+type>0){
            const {actions:{startLoading, endLoading}} = this.props
            try {
                startLoading()
                const {errno, errmsg, data} = await http.postCartUpdate({goodsId: goods_id, id, number:number + type, productId: product_id})
                endLoading()
                if(errno===0){
                    cartList[cartList.indexOf(item)].number = number+type
                    const {cartTotal:{checkedGoodsAmount, goodsCount, checkedGoodsCount}} = data
                    this.setState({
                        cartList,
                        checkedGoodsAmount,
                        goodsCount,
                        checkedGoodsCount
                    })
                }else{
                    Toast.fail(errmsg, .5,() => {
                        if(errno === 401){
                            this.props.actions.loginFailure()
                        }
                    })
                }
            }catch (e) {
                endLoading()
                throw e
            }
        }
    }
    /*编辑状态对商品全选操作*/
    checkAllEdit (cartList) {
        const bol = cartList.every((item) => {
            return item.isHasEdit === 1
        })
        cartList.forEach((item) => {
            item.isHasEdit = bol?false: true
        })
        this.setState({
            cartList
        })
    }
    /*非编辑状态对商品全选操作*/
    async checkAllCartGoods (cartList) {
        const ids = []
        const bol = cartList.every((item) => {
            return item.checked === 1
        })
        cartList.forEach((item) => {
            ids.push(item.product_id)
        })
        const {actions:{startLoading, endLoading}} = this.props
        try {
            startLoading()
            const {errno, errmsg, data} = await http.postCartCheck({isChecked: bol?0:1, productIds: ids.join(',')})
            if(errno === 0){
                const {cartList, cartTotal:{checkedGoodsAmount, goodsCount, checkedGoodsCount}} = data
                cartList.forEach((item) => {
                    item.isHasEdit = false
                })
                this.setState({
                    cartList,
                    checkedGoodsAmount,
                    goodsCount,
                    checkedGoodsCount
                })
            }else{
                Toast.fail(errmsg, .5,() => {
                    if(errno === 401){
                        this.props.actions.loginFailure()
                    }
                })
            }
            endLoading()
        }catch (e) {
            endLoading()
            throw e
        }
    }
    /*编辑状态对切换商品是否选中*/
    checkGoodsEdit (index) {
        const {cartList} = this.state
        cartList[index].isHasEdit = ! cartList[index].isHasEdit
        this.setState({cartList})
    }
    /*删除购物车已经选中的商品*/
    async deleteHasEdit (cartLists) {
        const {actions:{startLoading, endLoading}} = this.props
        try {
            startLoading()
            const productIds = []
            cartLists.forEach((item) => {
                if(item.isHasEdit){
                    productIds.push(item.product_id)
                }
            })
            const {errno, errmsg, data} = await http.postCartDelete({productIds:productIds.join(',')})
            if(errno === 0){
                const {cartList, cartTotal:{checkedGoodsAmount, goodsCount, checkedGoodsCount}} = data
                cartList.forEach((item) => {
                    item.isHasEdit = false
                })
                this.setState({
                    cartList,
                    checkedGoodsAmount,
                    goodsCount,
                    checkedGoodsCount,
                    isEdit: false
                })
            }else{
                Toast.fail(errmsg, .5,() => {
                    if(errno === 401){
                        this.props.actions.loginFailure()
                    }
                })
            }
            endLoading()
        }catch (e) {
            endLoading()
            throw e
        }
    }
    /*支付订单*/
    payGoods () {
        Toast.loading('下单功能还未GET,耐心等待~', 1)
    }
    toGoods (item) {
        this.props.history.push(`/goods/${item.goods_id}`)
    }
    render ()   {
        const {cartList, checkedGoodsAmount, goodsCount, checkedGoodsCount ,isEdit} = this.state
        const hasEdit =  cartList.filter((item) => {
            return item.isHasEdit
        })
        return (
          <div id="cart">
              <ul className="serviceList">
                  <li><span>★</span>30天无忧退货</li>
                  <li><span>★</span>48小时快速退款</li>
                  <li><span>★</span>满88元免邮费</li>
              </ul>
              <div className="cartGoodsListWrap">
                  {cartList.map((item, index) => (
                  !isEdit?
                      <div className="cartGoodsItem" key={item.id}>
                          <div className="isCheckItem" onClick={this.checkCartGoods.bind(this, item)}>
                              <img src={item.checked?isCheck:noCheck} alt="check"/>
                          </div>
                          <div className="goodsImg" onClick={this.toGoods.bind(this,item)}>
                              <img src={item.list_pic_url} alt=""/>
                          </div>
                          <div className="cartGoodsMsg">
                              <div>{item.goods_name}</div>
                              <div>{item.goods_specifition_name_value}</div>
                              <div  style={{color: 'red'}}>￥{item.retail_price}</div>
                          </div>
                          <div className="cartGoodsNum">x{item.number}</div>
                      </div> :
                      <div className="cartGoodsItem" key={item.id}>
                          <div className="isCheckItem" onClick={this.checkGoodsEdit.bind(this, index)}>
                              <img src={item.isHasEdit?isCheck:noCheck} alt="check"/>
                          </div>
                          <div className="goodsImg">
                              <img src={item.list_pic_url} alt=""/>
                          </div>
                          <div className="cartGoodEditWrap">
                              <div  className="cartEditSizeName">
                                  已选择：{item.goods_specifition_name_value}
                              </div>
                              <div className="cartEditNum">
                                  <div style={{color: 'red'}}>￥{item.retail_price}</div>
                                  <div>
                                      <div className="countOp">
                                          <div onClick={this.addOrDelete.bind(this, item, -1, cartList)}>-</div>
                                          <div>{item.number}</div>
                                          <div onClick={this.addOrDelete.bind(this, item, 1, cartList)}>+</div>
                                      </div>
                                  </div>
                              </div>
                          </div>
                      </div>
                  ))}
              </div>
              {
                  cartList.length?
                      (!isEdit? <div className="cartGoodsDo">
                          <div className="isCheckItem" onClick={this.checkAllCartGoods.bind(this, cartList)}>
                              <img src={checkedGoodsCount===goodsCount?isCheck:noCheck} alt="check"/>
                          </div>
                          <div className="cartMsgAll">
                              已选({checkedGoodsCount})  ￥{checkedGoodsAmount}
                          </div>
                          <div className="cartAllDoButton" onClick={this.changeEdit.bind(this ,isEdit, cartList)}>编辑</div>
                          <div className="cartAllDoButton pay" onClick={this.payGoods.bind(this)}>下单</div>
                      </div>: <div className="cartGoodsDo">
                          <div className="isCheckItem" onClick={this.checkAllEdit.bind(this, cartList)}>
                              <img src={hasEdit.length===cartList.length?isCheck:noCheck} alt="check"/>
                          </div>
                          <div className="cartMsgAll">
                              已选({hasEdit.length})
                          </div>
                          <div className="cartAllDoButton" onClick={this.changeEdit.bind(this ,isEdit, cartList)}>完成</div>
                          <div className="cartAllDoButton pay" onClick={this.deleteHasEdit.bind(this, cartList)}>删除所选</div>
                      </div>):(
                          <Fragment>
                              <img className="noGoods" src={noGoods} alt="noGoods"/>
                              <div className="noGoods">去添加点什么吧~</div>
                          </Fragment>
                      )
              }
          </div>
        )
  }
}
const mapStateToProps = (state, props) => ({...state.common})
const mapDispatchToProps = dispatch => ({actions: bindActionCreators(commonAction, dispatch)})
export default withRouter(connect(mapStateToProps, mapDispatchToProps)(Cart))
