import React, {Component, Fragment} from 'react'
import { connect } from 'react-redux';
import { bindActionCreators } from 'redux';
import *as catalogAction from '../../redux/actions/catelog'
import *as goodsAction from '../../redux/actions/goods'
import { Tabs,  } from 'antd-mobile';
import {withRouter ,Link} from 'react-router-dom'
import './index.css'
import ImgLazyLoad from '../common/imgLazyLoad'
class Catelog extends Component{
  saveRef = ref => {this.refDom = ref}
  componentWillMount(){
    const {actions:{fetchInitData},actions1: {fetchCount},catelogId} = this.props
    fetchInitData({catelogId})
    fetchCount()
  }
  clickTab({id},index){
    const {actions:{fetchCatelogMsg, changeIdAndTabIndex}} = this.props
    fetchCatelogMsg({id})
    changeIdAndTabIndex({catelogId:id,tabIndex:index})
  }
  computedTabsProperty () {
    const {cateLogList} = this.props
    let page = 0
    let tabsHeight = 0
    if(cateLogList.length > 0 && this.refDom){
      const { clientHeight} = this.refDom;
      const tabLen =  cateLogList.length * 42
      tabsHeight = tabLen<clientHeight ? cateLogList.length * 42:clientHeight
      page = Math.floor(clientHeight / 42)
    }
    return {page,tabsHeight}
  }
  toSearch () {
    this.props.history.push('/goodsSearch')
  }
  render () {
    const {cateLogList,activeCatalogMsg,count,tabIndex } = this.props
    const {page, tabsHeight} = this.computedTabsProperty()
    return (
      <Fragment>
        <div className="searchWrap">
          <div className="searchInput" onClick={this.toSearch.bind(this)}>
            <i className="fa fa-search"></i><span>{`搜索商品，共${count}款好物`}</span>
          </div>
        </div>
        <div id="tabsWrap" ref={this.saveRef}>
          <div style={{height: tabsHeight + 'px'}}>
            <Tabs tabs={cateLogList}
                  tabBarUnderlineStyle={{left:"0",right:'100%'}}
                  onTabClick={this.clickTab.bind(this)}
                  page = {tabIndex}
                  tabDirection="vertical"  tabBarPosition="left"
                  renderTabBar={props =>
                    <Tabs.DefaultTabBar {...props} page={page}
                                        renderTab={props => <div className="tabItem">{props.name}</div> } />}/>
          </div>
        </div>
        <div className="categogContet">
          <div className="categoryWrap" style={{backgroundImage:`url(${activeCatalogMsg.wap_banner_url})`}}>
            {activeCatalogMsg.front_name}
          </div>
          <div className="categoryTitle">
            <div></div>{activeCatalogMsg.name}分类<div></div>
          </div>
          <div className="subCategory">
            {'subCategoryList' in activeCatalogMsg?activeCatalogMsg.subCategoryList.map((item) => (
              <Link className="subCategoryItem" to={`/categorys/${item.id}`} key={item.id}>
                <ImgLazyLoad
                  offSetTop={44}
                  realUrl = {item.wap_banner_url}>
                </ImgLazyLoad>
                <div className="subCategoryItemName">
                  {item.name}
                </div>
              </Link>
            )):null}
          </div>
        </div>
      </Fragment>
    )
  }
}
const mapStateToProps = (state, props) => ({
    ...state.catalog,
    count: state.goods.count
  })
const mapDispatchToProps = dispatch => ({
    actions: bindActionCreators(catalogAction, dispatch),
    actions1: bindActionCreators(goodsAction,dispatch)
  })
export default withRouter(connect(mapStateToProps, mapDispatchToProps)(Catelog))