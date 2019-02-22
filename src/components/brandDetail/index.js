import React, {Component, Fragment} from 'react'
import GoodsList from '../common/goodsList'
import { connect } from 'react-redux'
import { bindActionCreators } from 'redux'
import {withRouter} from 'react-router-dom'
import Header from '../header'
import * as goodsAction from '../../redux/actions/goods'
import * as brandAction from '../../redux/actions/brand'
import './index.scss'
import ImgLazyLoad from '../common/imgLazyLoad'
class BrandDetail extends Component{
  goBack () {
    const {history:{go}} = this.props
    go(-1)
  }
  componentWillMount () {
    const {match:{params:{id}},goodsAction:{fetchGoodsData}, brandAction:{fetchBrandDetail}} = this.props;
    fetchBrandDetail({id})
    fetchGoodsData({brandId:id,page:1,size:10000})
  }
  render () {
    const {brandDetail,goodsList} = this.props
    return (
      <Fragment>
        <Header clickLeft={this.goBack.bind(this)} title={brandDetail.name}></Header>
        <div className="brandDetail">
          <ImgLazyLoad
            offSetTop={44}
            realUrl = {brandDetail.list_pic_url}>
          </ImgLazyLoad>
          <div className="breadDesc">
            {brandDetail.simple_desc}
          </div>
        </div>
        <div className="brandGoodsList">
          <div className="goodsListWrap">
            <GoodsList goodsList={goodsList}></GoodsList>
          </div>
        </div>
      </Fragment>
    )
  }
}
const mapStateToProps = (state, props) => ({
    ...state.brand,
    goodsList: state.goods.goodsList
  })
const mapDispatchToProps = dispatch => ({
    goodsAction: bindActionCreators(goodsAction, dispatch),
    brandAction: bindActionCreators(brandAction, dispatch)
  })
export default withRouter(connect(mapStateToProps,mapDispatchToProps)(BrandDetail))