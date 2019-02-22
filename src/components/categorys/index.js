import React, {Component, Fragment} from 'react'
import GoodsList from '../common/goodsList'
import {withRouter} from 'react-router-dom'
import { Tabs } from 'antd-mobile';
import './index.scss'
import Header from '../header'
import { connect } from 'react-redux';
import { bindActionCreators } from 'redux';
import * as categorysAction from '../../redux/actions/categorys';
import * as goodsAction from '../../redux/actions/goods';
class Categors extends Component{
  state = {
    page: 0,
    currentCategoryId: 0
  }
  goBack (currentCategoryId) {
    this.props.history.go(-1)
  }
  componentWillMount() {
    const { actions:{fetchNavData},match:{params:{id}},goodsAction:{fetchGoodsData} } = this.props
    this.setState({
      currentCategoryId: id
    })
    fetchGoodsData({page:1, size:1000,categoryId:id})
    fetchNavData({id:id})
  }
  /*切换分类*/
  clickTab({id},index){
    if(this.state.currentCategoryId!==id){
      this.setState({
        page: index,
        currentCategoryId: id
      })
      const { actions:{fetchNavData},goodsAction:{fetchGoodsData}} = this.props
      fetchGoodsData({page:1, size:1000,categoryId:id})
      fetchNavData({id})
      window.scrollTo(0,0)
    }
  }
  componentWillReceiveProps (nextProps){
    const {brotherCategory} = this.props
    brotherCategory.forEach((item,index) => {
      if(item.id === Number(this.state.currentCategoryId)){
        this.setState({
          page: index
        })
      }
    })
  }
  render () {
    const {brotherCategory, currentCategory, goodsList} = this.props
    const {page, currentCategoryId} = this.state
    return (
      <Fragment>
        <Header clickLeft={this.goBack.bind(this, currentCategoryId)} title="奇趣分类"></Header>
        <div className="tabWrap">
          <Tabs tabs={brotherCategory}  page={page} onTabClick={this.clickTab.bind(this)} renderTab={props => <div className="tabsItem">{props.name}</div>}/>
        </div>
        <div className="categoryDetail">
          <div>{currentCategory.name}</div>
          <div>{currentCategory.front_name}</div>
        </div>
        <div className="goodsList">
          <GoodsList goodsList={goodsList}></GoodsList>
        </div>
      </Fragment>
    )
  }
}
const mapStateToProps = (state, props) => ({
    ...state.catrgorys,
    goodsList: state.goods.goodsList
  })

const mapDispatchToProps = dispatch => ({
    actions: bindActionCreators(categorysAction, dispatch),
    goodsAction: bindActionCreators(goodsAction, dispatch)
  })
export default withRouter(connect(mapStateToProps, mapDispatchToProps)(Categors))
