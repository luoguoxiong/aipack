import React, {Component} from 'react'
import {withRouter} from 'react-router-dom'
import SearchInput from '../../components/common/searchInput'
import GoodsList from '../../components/common/goodsList'
import http from '../../http'
import ascPng from '../../static/img/asc.png'
import descPng from '../../static/img/desc.png'
import defaultPng from '../../static/img/default.png'
import {bindActionCreators} from 'redux'
import {connect} from 'react-redux'
import './index.scss'
import * as goodsSearch from "../../redux/actions/goodsSearch";
class GoodsSearch extends Component{
  state = {
    /*
    * 状态属性
    *   placeholder: 初始化输入框的默认值
    *   historyKeywordList: 历史查询列表
    *   hotKeywordList: 热搜列表
    *   searchKeyWordList：模糊查询列表
    *   isOpenCateGoryList: 是否展开分类列表
    * */
    placeholder: '',
    historyKeywordList: [],
    hotKeywordList: [],
    searchKeyWordList: [],
    isOpenCateGoryList: false,
  }
  componentDidMount () {
    document.onclick = (e) => {
      if (!e.target.className.includes('searchConditionCategoryWrap') && !e.target.className.includes('chooseCategory') && this.state.isOpenCateGoryList){
        this.setState({isOpenCateGoryList: false})
      }
    }
  }
  componentWillUnmount () {
    document.onclick = false
  }
  componentWillMount (){
    this.getInitData()
  }
  // 获取初始化信息
  async getInitData () {
    try {
      const {defaultKeyword:{keyword}, historyKeywordList, hotKeywordList} = await http.getGoodsSearchMsg()
      this.setState({
        placeholder: keyword,
        historyKeywordList,
        hotKeywordList
      })
    }catch (e) {
      throw e
    }
  }
  goBack () {
    const {history:{go}} = this.props
    go(-1)
  }
  // 用户提交表单当前查询字
  search (val) {
    const { actions:{fetchData}, searchVal} = this.props
    this.props.actions.resetParmas()
    this.props.actions.changeSearchParmas({searchVal: val})
    fetchData({searchVal, sortType:1, priceSortStatus: 'default', searchCategoryId: 0,page:1 ,size: 100 })
    this.getInitData()
  }
  // input值改变，查询模糊查询，修改查询字段
  async changeVal (val){
    try {
      this.props.actions.changeSearchParmas({searchVal: val})
      this.setState({searchKeyWordList: []})
      if(val){
        const data = await http.getGoodsSearchKey({keyword: val})
        this.setState({searchKeyWordList: data})
      }
    }catch (e) {
      throw e
    }
  }
  /*取消当前查询：清空input值、模糊查询list、查询的商品*/
  cancel () {
    this.props.actions.resetParmas()
  }
  // 当input获取焦点时：1、如果goodsList不为空，则清空goodsList;2、当前input有值需获取模糊查询参数
  async inputFocus (val) {
    this.setState({searchKeyWordList: []})
    if(val){
      const data = await http.getGoodsSearchKey({keyword: val})
      this.setState({searchKeyWordList: data})
    }
  }
  // 选择模糊查询字段，填充input值，然后查询该字段商品*
  chooseItem (val) {
    this.props.actions.resetParmas()
    this.props.actions.changeSearchParmas({searchVal: val})
    const searchVal = val
    const { actions:{fetchData}} = this.props
    fetchData({searchVal, sortType:1, priceSortStatus: 'default', searchCategoryId: 0,page:1 ,size: 100 })
    this.getInitData()
    this.setState({searchKeyWordList: []})
  }
  /*修改排序类型*/
  changeSortType (type) {
    let { actions:{fetchData}, searchVal, searchCategoryId, searchCategoryList} = this.props
    let  priceSortStatus =  type === 1 ? 0 : this.props.priceSortStatus === 1 ? -1 : 1
    let sortType = type
    this.props.actions.changeSortParmas({
      sortType,
      priceSortStatus
    })
    fetchData({searchVal, sortType, priceSortStatus, searchCategoryId,page:1 ,size:100,searchCategoryList})
  }
  /*修改查询分类*/
  setSearcCategoryId (id) {
    let { actions:{fetchData}, priceSortStatus, sortType, searchVal, searchCategoryList} = this.props
    let searchCategoryId = id
    this.props.actions.changeCategoryIdParmas({
      searchCategoryId: id
    })
    fetchData({searchVal, sortType, priceSortStatus, searchCategoryId,page: 1 ,size: 100,searchCategoryList})
    this.setState({
      isOpenCateGoryList: false
    })
  }
  /*是否显示分类列表*/
  changeIsOpenCategory () {
    this.setState({isOpenCateGoryList: !this.state.isOpenCateGoryList})
  }
  /*删除历史*/
  async deleteHistory () {
    try {
      await http.getDeleteGoodsSearchHistory({})
      this.getInitData()
    }catch (e) {
      throw e
    }
  }
  render () {
    const { isOpenCateGoryList, placeholder, historyKeywordList, hotKeywordList, searchKeyWordList} = this.state
    const {searchVal, sortType, priceSortStatus, goodsList, searchCategoryId, searchCategoryList} = this.props
    return (
      <div className="searchPage">
        <div className="searchFix">
          <SearchInput submit={this.search.bind(this)}
                       goBack={this.goBack.bind(this)}
                       focus={this.inputFocus.bind(this)}
                       searchList={searchKeyWordList}
                       cancel = {this.cancel.bind(this)}
                       change={this.changeVal.bind(this)}
                       chooseItem = {this.chooseItem.bind(this)}
                       placeholder = {placeholder}
                       value={searchVal}>
          </SearchInput>
        </div>
        {
          /*当查询字段为空和查询商品为空显示推荐查询*/
          !searchVal.length && !goodsList.length?
            <div className="searchMsg">
              {
                historyKeywordList.length>0?
                  <div className="searchItemWrap">
                    <div className="title">
                      历史记录<i className="iconfont icon-delete" onClick={this.deleteHistory.bind(this)}></i>
                    </div>
                    <div className="listWrap">
                      {
                        historyKeywordList.map(item => (
                          <button className="listItem" key={item} onClick={this.chooseItem.bind(this,item)}>{item}</button>
                        ))
                      }
                    </div>
                  </div>: null
              }
              {
                hotKeywordList.length>0?
                  <div className="searchItemWrap">
                    <div className="title">
                      热门搜索
                    </div>
                    <div className="listWrap">
                      {
                        hotKeywordList.map(item => (
                          <button className={item.is_hot?'listItem active':'listItem'} key={item.keyword} onClick={this.chooseItem.bind(this,item.keyword)}>{item.keyword}</button>
                        ))
                      }
                    </div>
                  </div> :null
              }
            </div>:null
        }
        {
          goodsList.length?
          <div className="searchGoods">
              <div className="searchConditionWrap">
                <div className="searchCondition">
                  <div className={sortType===1?'active':''} onClick={this.changeSortType.bind(this, 1)}>综合</div>
                  <div className={sortType===2?'active':''} onClick={this.changeSortType.bind(this, 2)}>
                    价格
                    <img src={priceSortStatus===0?defaultPng:priceSortStatus>0?ascPng:descPng} alt="sort" className="sortPrice" />
                  </div>
                  <div className="chooseCategory" onClick={this.changeIsOpenCategory.bind(this)}>
                    {
                    searchCategoryList[searchCategoryList.findIndex(item => (item.id === searchCategoryId))].name + '分类'
                    }
                  </div>
                </div>
                {isOpenCateGoryList ?
                  <div className="searchConditionCategoryWrap onePx_top">
                    {
                      searchCategoryList.map(item => (
                        <button key={item.id} className={`categoryListItem ${item.id === searchCategoryId ? 'active' : ''}`}
                             onClick={this.setSearcCategoryId.bind(this, item.id)}>{item.name}</button>
                      ))
                    }
                  </div>: null
                }
              </div>
            <GoodsList goodsList={goodsList}></GoodsList>
          </div>:
            null
        }
      </div>
    )
  }
}
const mapStateToProps = (state, props) => ({...state.goodsSearch})
const mapDispatchToProps = dispatch => ({actions: bindActionCreators(goodsSearch, dispatch)})
export default withRouter(connect(mapStateToProps, mapDispatchToProps)(GoodsSearch))
