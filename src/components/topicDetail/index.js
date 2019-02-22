import React, {Component, Fragment} from 'react'
import Header from '../header'
import CommentList from '../common/commentList'
import {withRouter, Link} from 'react-router-dom'
import './index.scss'
import {connect} from "react-redux";
import {bindActionCreators} from 'redux'
import *as topicDetailAction from '../../redux/actions/topicDetail'
import commentPng from '../../static/img/comment.png'
import ImgLazyLoad from '../common/imgLazyLoad'
class TopicDetail extends Component{
  /*返回上一页*/
  goBack () {
    this.props.history.go(-1)
  }
  componentWillMount () {
    const {match:{params:{id}}} = this.props
    this.getTopicMsg(id)
  }
  /*跳转到评论编写页*/
  postWrite () {
    const {history:{push},match:{params:{id}}} = this.props
    push(`/topicCommentWrite/${id}`)
  }
  getTopicMsg (id) {
    this.props.actions.fetchData(id)
  }
  render () {
    const {match:{params:{id}}, topicDetail:{title,content},topicComment,topicRelateds,topicCommentCount} = this.props
    return(
    <div className="topicDetail">
      <Header clickLeft={this.goBack.bind(this)} title={title}></Header>
      <div  dangerouslySetInnerHTML={{__html:content}} className="topicDetailImg"></div>

      <div className="commentWrap">
        <div className="titleLine">
          <div className="titleName">精选留言</div>
          <div className="titleIcon" onClick={this.postWrite.bind(this)}><i className="iconfont icon-pencil" aria-hidden="true"></i></div>
        </div>
        {topicCommentCount>0 ?
          <Fragment>
            <CommentList commentList ={topicComment}></CommentList>
          </Fragment>:
            <div className="noComment">
              <div className="noCommentIcon">
                <img src={commentPng} alt=""/>
                <div>等你来留言</div>
              </div>
            </div>
        }
        {topicCommentCount>5 ?
            <Link to={`/comment/${id}?typeId=1`} className="moreComment">
              查看更多评论
            </Link> : null
        }
      </div>

      <div className="relateTopic">
        <div className="relateTopicTitle">推荐专题</div>
        {
          topicRelateds.map(item => {
            return (
              <div className="relateTopicItem" onClick={this.getTopicMsg.bind(this,item.id)} key={item.id}>
                <ImgLazyLoad
                  offSetTop={44}
                  realUrl = {item.scene_pic_url}>
                </ImgLazyLoad>
                <div>{item.title}</div>
              </div>
            )
          })
        }
      </div>
    </div>
    )
  }
}
const mapStateToProps = (state, props) => ({...state.topicDetail})
const mapDispatchToProps = dispatch => ({actions: bindActionCreators(topicDetailAction, dispatch)})
export default withRouter(connect(mapStateToProps, mapDispatchToProps)(TopicDetail))