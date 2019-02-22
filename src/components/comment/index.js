import React, {Component, Fragment} from 'react'
import Header from '../header'
import CommentList from '../common/commentList'
import {withRouter} from 'react-router-dom'
import './index.scss'
import {connect} from "react-redux";
import {bindActionCreators} from 'redux'
import *as commentAction from '../../redux/actions/comment'
class comment extends Component{
  state = {
    page: 1,
    size: 100
  }
  goBack () {
    const {history:{go}} = this.props
    go(-1)
  }
  componentWillMount () {
    const {match:{params:{id}},actions:{fetchData}, location:{search}} = this.props
    const {page, size} = this.state
    fetchData({id, page, size, typeId: search.split('=')[1]})
  }
  render () {
    const {comment} = this.props
    return (
      <Fragment>
          <Header clickLeft={this.goBack.bind(this)} title='查看更多评论'></Header>
          <CommentList commentList ={comment}></CommentList>
      </Fragment>
    )
  }
}
const mapStateToProps = (state, props) => ({...state.comment})
const mapDispatchToProps = dispatch => ({actions: bindActionCreators(commentAction, dispatch)})
export default withRouter(connect(mapStateToProps, mapDispatchToProps)(comment))