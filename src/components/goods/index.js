import React, {Component} from 'react'
import {Link, withRouter} from 'react-router-dom'
import Header from '../header'
import './index.scss'
import http from '../../http'
import ImgLazyLoad from '../common/imgLazyLoad'
import { Carousel, Toast } from 'antd-mobile'
import { connect } from 'react-redux';
import { bindActionCreators } from 'redux';
import * as commonAction from '../../redux/actions/common';
import { Modal } from 'antd-mobile';
import CommentList from '../common/commentList'
class Goods extends Component{
  state = {
    info: {
      goodsName: '',
      subTitle: '',
      goods_desc: null
    },
    brand: {},
    gallery: [],
    comment: {},
    attribute: [],
    issue: [],
    goodsList: [],
    specificationList: [],
    productList: [],
    goodsCount: 0,
    userHasCollect: 0,
    goodsBuyNum: 0,
    isShowSize: false
  }
  componentDidMount() {
    this.fetchData(this.props.match.params.id)
    this.fetchCartNum()
  }
  /*获取商品相关信息*/
  async fetchData (id) {
    const {actions} = this.props
    try {
      actions.startLoading()
      const data = await http.getGoodsDetail({id})
      const {goodsList} = await http.getGoodsRelated({id})
      let {info, gallery, brand, comment, attribute,issue, specificationList, productList, userHasCollect} = data
      specificationList.forEach((item) => {
        item.activeId = item.valueList[0].id
      })
      this.setState({
        info:{
          goodsName: info.name,
          subTitle: info.goods_brief,
          goods_desc: info.goods_desc
        },
        userHasCollect,
        comment,
        brand,
        gallery,
        attribute,
        issue,
        goodsList,
        specificationList,
        productList
      })
      actions.endLoading()
    }catch (e) {
      actions.endLoading()
      throw e
    }
  }
  /*获取购物车商品数量*/
  async fetchCartNum () {
    try {
      const {errno, errmsg, cartTotal} = await http.getCartNum({})
      if(errno===401){
          Toast.fail(errmsg, .5,() => {
            this.props.actions.loginFailure()
          })
      }else{
        this.setState({goodsCount:cartTotal.goodsCount})
      }
    } catch (e) {
        throw e
    }
  }
  /*添加到我喜欢*/
  async changeLikes () {
    const {data:{type}} = await http.postDoLikes({typeId: 0, valueId: this.props.match.params.id})
    this.setState({userHasCollect: type==='add'?1:0})
  }
  /*修改购买数量*/
  changeBuyNum (val ,stock) {
    if(this.state.goodsBuyNum + val >= 0 && this.state.goodsBuyNum + val <= stock){
      this.setState({
        goodsBuyNum: this.state.goodsBuyNum + val
      })
    }
  }
  goBack () {
    const {history:{go}} = this.props
    go(-1)
  }
  /*是否显示规格属性*/
  changeIsShowSize () {
    this.setState({
      isShowSize: !this.state.isShowSize
    })
  }
  componentWillReceiveProps(newP){
    if(this.props.match.params.id!==newP.match.params.id){
        this.fetchData(newP.match.params.id)
    }
  }
  /*选择某个规格属性*/
  changeSizeActiveId (index, item) {
    const {specificationList, productList ,goodsBuyNum} = this.state
    if(specificationList[index].activeId!==item.id){
      specificationList[index].activeId = item.id
      const {stock} = this.computedGoodsSizePriceAndSizeName(specificationList, productList)
      this.setState({
        specificationList,
        goodsBuyNum: goodsBuyNum>stock?stock:goodsBuyNum
      })
    }
  }
  /*添加到购物车*/
  async addCart (priceId, goodsBuyNum, isShowSize){
    if(!isShowSize){
      this.setState({isShowSize: true})
      return null
    }
    if(goodsBuyNum<1){
      Toast.fail('请选择商品数量',1)
      return null
    }
    const {errno, errmsg} = await http.postAddCart({goodsId: this.props.match.params.id, number: goodsBuyNum, productId:priceId})
    if(errno === 0){
        Toast.success('添加成功！',.5, () =>{
            this.fetchCartNum()
        })
    }else{
      Toast.fail(errmsg, .5,() => {
        if(errno === 401){
          this.props.actions.loginFailure()
        }
      })
    }
  }
  /*支付订单*/
  payGoods () {
    Toast.loading('下单功能还未GET,耐心等待~', 1)
  }
  /**
   *
   * @param sizeList
   * @param priceList
   * @returns {{hasChooseSizeName: string, price: number, stock: number, priceId: *}}
   */
  computedGoodsSizePriceAndSizeName(sizeList, priceList){
    let hasChooseSize = []
    let sizePriceIndex = []
    let price = 0
    let stock = 0
    let priceId = null
    sizeList.forEach((item) => {
      item.valueList.forEach((temp) => {
        if(item.activeId === temp.id){
          sizePriceIndex.push(temp.id)
          hasChooseSize.push(temp.value)
        }
      })
    })
    priceList.forEach((item) => {
      if(item.goods_specification_ids === sizePriceIndex.join('_')){
        price = item.retail_price
        stock = item.goods_number
        priceId = item.id
      }
    })
    return {
      hasChooseSizeName: hasChooseSize.join('、'),
      price,
      stock,
      priceId
    }
  }
  render () {
    const {info:{goodsName, subTitle, goods_desc},
      brand ,gallery, isShowSize, comment, attribute, goodsCount, userHasCollect, goodsBuyNum,
      issue, goodsList, specificationList, productList} = this.state
    const {hasChooseSizeName, price, stock,priceId  } = this.computedGoodsSizePriceAndSizeName(specificationList, productList)
    const {history:{push}, isloading} = this.props
    return (
        !isloading?(
            <div className="goodsPage">
              <Modal
                  popup
                  visible={isShowSize}
                  onClose={this.changeIsShowSize.bind(this)}
                  animationType="slide-up"
              >
                <div className="goodsSizeDo">
                  <div className="goodsSizeSetMsg">
                    {gallery.length? <img src={gallery[0].img_url} alt="goods"/>:null}
                    <div className="gooodsSizePriceAndSize">
                      <div>单价: <span>￥{price}</span></div>
                      <div>库存: <span>{stock}件</span></div>
                      <div>已选择:
                        <br/>{hasChooseSizeName}</div>
                    </div>
                    <div className="closeModel" onClick={this.changeIsShowSize.bind(this)}>
                      <i className="iconfont icon-cc-close-square"></i>
                    </div>
                  </div>
                  <div className="goodsSizeWrap">
                    {
                      specificationList.map((item, index) => ((
                        <div className="goodsSizeItem" key={item.specification_id}>
                          <div className="goodsSizeItemName">{item.name}</div>
                          <div className="goodsSizeListWrap">
                            {
                              item.valueList.map(temp => (
                                  <div className={item.activeId === temp.id?'goodsSizeListItem active':'goodsSizeListItem'}
                                       onClick={this.changeSizeActiveId.bind(this, index, temp, stock)} key={temp.id}>{temp.value}
                                  </div>
                              ))
                            }
                          </div>
                        </div>
                        )))
                    }
                    <div className="goodsSizeItem">
                      <div className="goodsSizeItemName">数量</div>
                      {
                        stock>0?(
                            <div className="goodsSizeListWrap">
                              <div className="goodsBuyCount">
                                <div className="onePx_border" onClick={this.changeBuyNum.bind(this, -1, stock)}>-</div>
                                <div className="onePx_border">{goodsBuyNum}</div>
                                <div className="onePx_border" onClick={this.changeBuyNum.bind(this,1, stock)}>+</div>
                              </div>
                            </div>
                        ):(
                            <div className="goodsSizeListWrap">已售馨!</div>
                        )
                      }
                    </div>
                  </div>
                </div>
                <div className="goodsDoWrap">
                  <div onClick={this.addCart.bind(this,priceId,goodsBuyNum, isShowSize)}>加入购物车</div>
                  <div  onClick={this.payGoods.bind(this)}>立即下单</div>
                </div>
              </Modal>
              <Header clickLeft={this.goBack.bind(this)} title={goodsName}></Header>
              <Carousel autoplay infinite>
                {gallery.map(item => (
                    <div className="goodsBannerItem" key={item.id}>
                      <ImgLazyLoad
                          offSetTop={0}
                          realUrl = {item.img_url}>
                      </ImgLazyLoad>
                    </div>
                ))}
              </Carousel>
              <ul className="serviceList">
                <li><span>★</span>30天无忧退货</li>
                <li><span>★</span>48小时快速退款</li>
                <li><span>★</span>满88元免邮费</li>
              </ul>
              <div className="goodsMsgWrap">
                <div className="goodsNameTitle">{goodsName}</div>
                <div className="goodsNameSubTitle">{subTitle}</div>
                <div className="goodsPriceTitle">￥{price}</div>
                {
                  'name' in brand?(
                      <div className="goodsBrandTitle" onClick={() => {push(`/brandDetail/${brand.id}`)}}>
                        <div>{brand.name}</div>
                      </div>
                  ): null
                }
              </div>
              <div className="goodsSize" onClick={this.changeIsShowSize.bind(this)}>
                <div>{hasChooseSizeName}</div>
                <div>x {goodsBuyNum}</div>
                <div>
                  选择规格<i className="iconfont icon-right"></i>
                </div>
              </div>
              {comment.count?<div className="goodsComment">
                    <div className="goodsCommentTitle">
                      <div>评论 ({comment.count})</div>
                      <div>
                        <Link to={`/comment/${this.props.match.params.id}?typeId=0`} >
                          查看全部<i className="iconfont icon-right"></i>
                        </Link>
                      </div>
                    </div>
                    {
                      'data' in comment? <CommentList commentList ={[comment.data]}></CommentList>:null
                    }
                  </div> :null}
              <div className="goodsAttribute">
                <div className="goodsAttributeLine">
                  商品参数
                </div>
                <div className="goodsAttributeList">
                  {
                    attribute.map((item) => (
                        <div className="goodsAttributeItem" key={item.name}>
                          <div className="attributeLabel">{item.name}</div>
                          <div className="attributeContent">{item.value}</div>
                        </div>
                    ))
                  }
                </div>
              </div>
              <div  dangerouslySetInnerHTML={{__html:goods_desc}} className="topicDetailImg"></div>
              <div className="goodsAttribute">
                <div className="goodsAttributeLine">
                  常见问题
                </div>
                {
                  issue.map((item) => (
                      <div className="problemWrap" key={item.id}>
                        <div className="problemLabel">
                          <span>√</span>{item.question}
                        </div>
                        <div className="problemContent">
                          {item.answer}
                        </div>
                      </div>

                  ))
                }
              </div>
              <div className="goodsAttribute">
                <div className="goodsAttributeLine">
                  大家都在看
                </div>
              </div>
              <div className="goodsList">
                {goodsList.map((item) => {
                  return(
                      <Link to={`/goods/${item.id}`} key={item.id} className="goodsItem">
                        <div className="goodsItemImg">
                          <ImgLazyLoad
                              offSetTop={44}
                              realUrl = {item.list_pic_url}>
                          </ImgLazyLoad>
                        </div>
                        <div className="goodsItemName">{item.name}</div>
                        <div className="goodsItemPrice">￥{item.retail_price}元</div>
                      </Link>
                  )
                })}
              </div>
              <div className="goodsPageDo">
                <div className={userHasCollect===1?'isLike like': 'isLike'} onClick={this.changeLikes.bind(this)}>
                  {userHasCollect===1?'★': '☆'}
                </div>
                <div className="cartNum" onClick={() => {push(`/cart`)}}>
                  <i className="iconfont icon-Add-Cart">
                    <span>{goodsCount}</span>
                  </i>
                </div>
                <div className="addCart" onClick={this.addCart.bind(this,priceId, goodsBuyNum, isShowSize)}>加入购物车</div>
                <div className="payGoods" onClick={this.payGoods.bind(this)}>立即购买</div>
              </div>
            </div>
            ):null
    )
  }
}
const mapStateToProps = (state, props) => ({...state.common})
const mapDispatchToProps = dispatch => ({actions: bindActionCreators(commonAction, dispatch)})
export default withRouter(connect(mapStateToProps, mapDispatchToProps)(Goods))